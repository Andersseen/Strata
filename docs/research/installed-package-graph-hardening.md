# Installed package server-only graph integrity

Date: 2026-11-06. Branch `fix/server-only-installed-package-graph`. Starting main:
`316a569bc9ad9d70d0e43a415d4033549dbe5c94` (the brief named `ed31257`; release PR #174 merged after it, with no
runtime change). The final implementation SHA is the head of the pull request that carries this report.

Evidence levels, never interchangeably: UNIT, PACKED CONSUMER (real tarballs installed outside the workspace), LOCAL
NODE, LOCAL WORKERD, CHROMIUM, HOSTED CI, DEPLOYED.

Toolchain: Vite 8.3.0, Rolldown 1.2.8, Angular 22, TypeScript 6.0.3, Node 22.23.1 (local).

## Result

The documented R05 gap said pre-analysis does not traverse installed package re-exports. Measured against the installed
tarballs, that gap was mostly a **diagnostic** gap: every package re-export reached by an ordinary import already failed
the build safely. The real defects were elsewhere and larger. Access that never parses a module, and worker graphs,
**shipped server-only source in a successful production build**. Workers did so for marked application modules too, not
only packages.

## Baseline, measured before any change

Real `vite build` and Vite dev servers, plugin from `main`, `@acme/server-kit` installed from its tarball.

### Already failing safely (not new findings)

| Browser path                                                                    | Result on `main`                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------- |
| Named import of an asserting subpath                                            | Build refused at the assertion                    |
| Barrel or chained barrel, safe export selected, side-effect import of a barrel  | Build refused, importer chain as Rolldown knew it |
| Dynamic `import()`, `import.meta.glob` without a query, `?inline`               | Build refused                                     |
| App module: `?raw`, `?url`, `?worker`; an app barrel re-exporting a package     | Build refused                                     |
| Dev optimizer: cold, warm, forced, startup scan, `include`, linked              | Refused (0.9 firewall)                            |
| Warm optimizer cache written with `enabled: false`, then the firewall turned on | Refused (HTTP 504), nothing private served        |

The weakness in these rows was the diagnostic: the message named the asserting module and the bundler's chain, with no
package entry and with wording about the pre-scan.

### Genuine exposure

| Browser path                                                  | Build on `main` | Output on `main`                                         |
| ------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| `pkg/secret?raw`, dynamic, by `/node_modules/…` path, by glob | **succeeds**    | Module source in a browser chunk                         |
| `pkg/secret?url`, `?url&inline`                               | **succeeds**    | Source base64-inlined, or emitted as a plain `.js` asset |
| `new URL("…/secret.js", import.meta.url)`, package **or app** | **succeeds**    | Source base64-inlined or emitted                         |
| `pkg/effect?worker`, `?worker&inline`                         | **succeeds**    | Implementation in the worker bundle                      |
| `new Worker(new URL(…))`, package **or app** module           | **succeeds**    | Implementation in the worker bundle                      |
| App worker importing a marked package **or app** module       | **succeeds**    | Implementation in the worker bundle                      |
| App worker importing `pkg/secret?raw`                         | **succeeds**    | Module source in the worker bundle                       |
| Dev: `?raw` by import, `import()`, glob or direct request     | HTTP 200        | Module source served                                     |

Causes:

1. A bare specifier skipped the plugin's check, and `load` only knew app modules. Under `?raw`, `?url` and `?worker` the
   file is never parsed as a module, so its own assertion import never reaches `resolveId`.
2. Vite builds each worker in a separate bundler pass **without the application's plugins**, under the environment name
   `client`.
3. `new URL()` is resolved by Vite outside the plugin pipeline. No hook is told about the file.

The existing leak scans could not see part of this: below `assetsInlineLimit` the source is base64 inside a chunk, so a
substring scan reports it clean. The new scan decodes data URLs.

## Implementation

No second graph, no new option or export. All in `packages/server-components/src/vite`:

- `server-only.ts`: `findServerOnlyChain` walks re-export edges downward from one entry, breadth-first, each module once
  (cycles terminate, the chain is a shortest one, in declaration order). It reuses `serverOnlyFacts`. Ordinary imports
  are not followed, because the bundler reaches them and the check runs again there. `createInstalledFacts` keeps a parse
  until a file's size or mtime changes, and skips the parse when a file has neither the specifier nor a re-export.
- `plugin.ts`: the client hooks are one `browserGraph` object. `resolveId` resolves every import with Vite's public
  `createIdResolver(config, { scan: true })` for the client environment: real `exports`, `browser`/`import` conditions,
  `imports`, aliases, and the package file rather than an optimized chunk. It runs at the real import boundary, after
  the compiler dropped type-only imports, so there is nothing to second-guess.
- `load` refuses a query id that arrived without `resolveId`, because a plugin ahead of Strata's resolved it.
- `worker.plugins` (public; Vite concatenates it with the application's) gives each worker bundle the same hooks.
- `generateBundle` reads emitted files: an asset that is a module, or a base64 data URL in a chunk, asserting server-only
  fails the build before anything is written. A chunk that merely displays the assertion as a string is not a copy of a
  module and is not refused; this is tested, because the documentation site does exactly that.
- `export { type T } from` is no longer a runtime re-export. `serverOnlyFacts` pinned the opposite in a unit test, which
  was changed deliberately: if a compiler keeps the statement, the load is refused anyway.

The walk is bounded by construction, since it starts only from what a browser graph reaches and follows only re-exports,
and by a limit of 4,096 modules per entry. At the limit it warns and gives no verdict; modules beyond it are still met
by the bundler. `resolveId` skips the check during Vite's dependency scan, which sees imports a compiler would drop. The
`scan` flag is passed at runtime and not typed on the hook; without it the check would merely also run during the scan,
which fails closed.

Cost: parsing the re-export closure of `@angular/core`, `common` and `router` (8 of 30 files, 1.7 MB scanned) took about
100 ms, once per build. One extra resolve per import.

### Diagnostic

```text
[strata] Server-only module entered the browser graph: node_modules/@acme/server-kit/chain.js
Package entry: @acme/server-kit/chain
Imported from: src/entry.ts
Reason: it re-exports a server-only module: node_modules/@acme/server-kit/chain.js → node_modules/@acme/server-kit/barrel.js → node_modules/@acme/server-kit/secret.js, which declares `import "@strata-sc/server-components/server-only";`. A module that re-exports a server-only module is server-only for the browser, whichever of its exports the importer selects.
Import the browser-safe exports from a package subpath that does not reach this module, or use the module only from a @ServerComponent() or the server-owned components it renders and pass plain data to the island through [strataClient]. Only this entry is refused, not the package.
```

Paths are package-relative. A path specifier is not echoed as the entry, because it can name the machine. Application
source diagnostics are unchanged.

### Ordering

Three orderings were observed and none depends on luck:

| Situation                                      | What happens                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Forbidden import, no other error               | Strata refuses at `resolveId`                                                                                                                  |
| Forbidden import and an Angular template error | Angular reported first in the measured run (`strata=false angular=true`). The build still fails, with a cause, and no private value is emitted |
| Dev, entry scanned or `include`d at startup    | Refused at the import with HTTP 500, or the optimizer rejection ends the process, or both in sequence (2 of 12 probe runs). Both close         |

The third row changed: refusal at the import can now win the race that previously always ended in the process exiting.
The suite accepts each ordering and requires a refusal and no private byte in all of them. An intermittent "absolute
path" check failure during this work was traced, not retried away: in the third ordering Node's crash header follows the
HTML on stderr. The HTTP body was clean in all 12 runs. The harness slice now ends at that header.

## Regression evidence

`pnpm test:server-component-optimized-deps`, PACKED CONSUMER: tarballs installed by npm outside the repository.
Package shapes: ESM with `exports`, conditional exports, `imports` (`#secret`), `sideEffects`, TypeScript source,
CommonJS, a hand-shaped Angular Package Format tarball (`fesm2022/*.mjs`, shared chunk, secondary entries, `types`
conditions) and a chain across two packages.

| #   | Required scenario                             | Evidence                                                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Safe export builds                            | Root, subpath, safe barrel, APF entries: dev and production                                                   |
| 2   | Server-only export fails                      | Direct subpath, APF secondary entry, CommonJS entry                                                           |
| 3   | Barrel fails                                  | Wildcard, named, namespace, `#imports`, cross-package, APF, ngc-compiled barrel                               |
| 4   | Chained barrel fails                          | ESM and real Analog build                                                                                     |
| 5   | Dynamic or `@defer` fails                     | Installed `import()`; real Analog `@defer` of a server-only package component                                 |
| 6   | Raw or URL access fails                       | `?raw`, `?url`, `?url&inline`, by path, by glob, `new URL()`, direct dev request; worker forms                |
| 7   | Type-only: no false positive                  | `export type`, `export { type T } from` in a TypeScript-source package                                        |
| 8   | Unrelated safe subpath stays usable           | Safe subpaths of packages with server-only entries; `browser` condition of a server-only barrel               |
| 9   | Cycles terminate deterministically            | Safe cycle builds; cycle hiding an assertion is refused, with the exact chain; unit test for order            |
| 10  | Server Component legitimately imports         | Analog consumer renders a value from `@strata-test/kit/server` on Node and workerd; Chromium hydrates it      |
| 11  | No implementation or canary in assets or maps | Marker scan with data URLs decoded; `KIT_CANARY` added to every browser, HTML and script scan of the consumer |
| 12  | Negative control                              | See below                                                                                                     |

`pnpm test:server-component-package-consumer` repeats the forms against a real Analog application with AOT, Nitro Node,
local workerd and Chromium. Unit: 13 new tests in `server-only.test.ts`, one in `plugin.test.ts`.

### Negative controls

Each of the 15 access scenarios first builds with `enabled: false` and must ship the markers, so a refusal cannot pass
vacuously. The Analog consumer has the same control for `?raw`. Then each guard was removed in turn, the plugin rebuilt
and repacked, and the suite run:

| Mutation                           | Failing checks | What this shows                                                                      |
| ---------------------------------- | -------------: | ------------------------------------------------------------------------------------ |
| M0: `main`'s plugin sources        |             72 | The suite detects the original exposure                                              |
| M1: no package walk at `resolveId` |              6 | Diagnostics and the warm-cache refusal depend on it; `load` still stops query access |
| M2: no query guard in `load`       |              2 | Pinned by the earlier-plugin scenario (see below)                                    |
| M3: no worker guard                |             15 | Every worker scenario depends on it                                                  |
| M4: no emitted-output check        |              6 | `new URL()` depends on it                                                            |

M2 first reported **0** failures, which disproved this work's own assumption: a direct dev request does not reach `load`
without `resolveId`, because Vite's dev container supplies a default importer. The guard's real job is a query id
resolved by an earlier plugin, so the comment and message were corrected and a scenario added for it. The rerun fails
exactly its two checks.

## Dependency optimizer and dev mode

The optimizer plugin is unchanged and still needed: it is the only check that sees a package's internal imports under
pre-bundling. Existing protection covered most of this; the additions are regression evidence.

| State                              | Result                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh install, no cache            | Refused, nothing private served                                                                                                                                                                                   |
| Clean optimizer cache              | Refused                                                                                                                                                                                                           |
| Warm cache                         | Refused. Now at the import, from the package file, whatever the cache holds                                                                                                                                       |
| Warm cache from an unprotected run | Refused                                                                                                                                                                                                           |
| In-place `node_modules` edit       | **Unsupported.** The directly imported entry is re-read and refused. A module behind an ordinary import stays in the stale chunk until `--force` or a cold cache: measured, logged by the suite, not claimed away |

Live failure and recovery for source edits is unchanged (`pnpm test:server-component-dev`). No package hot reload was
added.

## Local verification

All 35 commands of `tools/ci/required-commands.json`, plus `pnpm install --frozen-lockfile` and `pnpm build`, run in
sequence with Node 22.23.1 on macOS. `actionlint` ran with the CI flags from the local Homebrew binary. The first pass had
four failures, all resolved and then rerun:

| Command                                       | First pass                                                         | Resolution and rerun                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`              | New fixture and test files                                         | Fixed; pass                                                                        |
| `pnpm test:server-component-package-consumer` | Canary missing from the Worker graph: the bundler folded `.length` | Fixture computes at runtime; pass, 335 checks                                      |
| `pnpm test:server-component-failures`         | `route.fetch: socket hang up` from the local server, mid-scenario  | **Not reproduced**: two isolated reruns pass. Cause unknown; lint ran alongside it |

`pnpm test:server-component-optimized-deps`: 510 checks pass. `pnpm test` includes `pnpm test:ci`.

Evidence by level: Node production, local workerd and Chromium are in the packed consumer and the full-stack consumer.
`test:full-stack-deployed-cloudflare` ran as a local rehearsal. **No real Cloudflare deployment was run from this branch.**

## Hosted CI and Extended

HOSTED CI run [42196635514](https://github.com/Andersseen/Strata/actions/runs/42196635514), head `e1e3468`: `Verify` and
every mandatory job pass. No job was added and no suite weakened.

| Measure                      | `main` run 42179720559 | This branch |
| ---------------------------- | ---------------------: | ----------: |
| Wall (created to last job)   |               12.9 min |    10.3 min |
| Runner time                  |               72.0 min |    62.5 min |
| Server Components packed job |                7.1 min |    10.2 min |
| Optimizer and dev server job |                5.5 min |     6.1 min |

Wall time sits at the top of the 9 to 10 minute baseline (#172 measured 9.2 to 10.2). One pair of runs is noise for most
jobs: several unrelated jobs were faster here. The packed job's +3.1 minutes is real, because the new real-Angular
scenarios run there, and it is now the critical path. If it grows further, it is the first candidate to split.

Extended run [42196703209](https://github.com/Andersseen/Strata/actions/runs/42196703209), `suite=all`, on the same head:
all jobs pass, including SSR integrity with repeated independent builds, the source-mutated security qualification on Node,
workerd and Chromium, and the browser size budgets. Its registry jobs exercise **published** packages, so they show no
regression in those flows and say nothing about this unreleased change.

## Remaining limitations

- **Unmarked code is not classified.** `?raw` of an unmarked private helper builds, even when a marked module imports it,
  and that helper ships. This is measured (`internal/impl.js?raw`). Only the assertion classifies a module; no claim is
  made from source semantics.
- The marker is recognized in its plain side-effect form. `require()` and `import {} from` are refused when loaded as a
  module, but not under a query or by `new URL()`.
- `new URL()` of a barrel is not refused: only its text is copied, with no implementation.
- A package export the consumer never imports is not analyzed.
- An app barrel re-exporting a package module is refused at its package import, not tainted by the pre-scan.
- Emitted files are recognized in the two forms Vite produces (asset, base64 data URL).
- Vite ending the dev process on a failed first optimizer run, and one refused entry failing its optimizer batch, are
  unchanged.

## Changeset

`minor` for `@strata-sc/server-components`. No API is added or removed, but a build that shipped a marked module through
a query, `new URL()` or a worker now fails, so this is not a silent patch. `core` and `analog` are untouched. No version
bump, no publish.

## Release 1.0 impact

No criterion is ticked; the matrix is unchanged. #7, #8, #9 and #23 stay PARTIAL with stronger evidence. #9's package
re-export reservation is closed for marked modules, and #23 gains decoded scans and per-guard mutation controls. Still
open for all of them: no real application, no real deployed run of this change, and unmarked dependencies protected by
ownership only.

Release state found on the way, outside this change: `@strata-sc/server-components@0.15.0` is published with
`latest=0.15.0`, but `next` is still `0.14.0`. Release run 42181130222 failed in `Align npm dist-tags` because the version
was not yet visible after six reads. Nothing here touches npm.
