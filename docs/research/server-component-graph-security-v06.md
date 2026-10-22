# Server-only build graph: module resolution and diagnostics (0.6 candidate)

Status: locally qualified implementation candidate on the feature branch; hosted CI and release
verification are pending. Starting `main` SHA: `5eaa35fe170ed914d42ba517c697486432e291e3` (PR #109).
Release ordering: the `0.5.0` version PR (#110) was still open at the starting SHA, so this work adds
an independent minor Changeset and is **not** versioned yet. The release PR for this change cannot
be separated from #110 until #110 is merged and released; Changesets will otherwise aggregate the
two minors.

## What changed

The invariant is unchanged: no Server Component implementation or explicitly server-only module may
enter a browser-executable graph through any supported module resolution path. What changed is how
many resolution paths the pre-scan and the diagnostics understand.

| Stage                      | Before                                   | Now                                                                                                     |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Re-export taint (pre-scan) | relative specifiers only                 | relative, directory `index`, `.js` → `.ts`, Vite `resolve.alias`, tsconfig `paths` / `baseUrl`          |
| Client `resolveId` check   | `.`- and `/`-prefixed specifiers only    | those, plus any bare specifier the generation's resolver maps to an app module                          |
| Client `load` backstop     | resolved id of anything loaded           | unchanged (still the final authority for anything Vite resolved by a route the pre-scan does not model) |
| Package assertion import   | rejected, importer unknown               | rejected, importer and import chain from the bundler (build) or the dev module graph                    |
| Diagnostics                | module, importer (if known), reason, fix | the same, plus the import chain, sanitized paths and an honest "unavailable" importer line              |
| Dev regeneration           | relative taint                           | taint follows aliases; a changed `tsconfig` also regenerates the graph                                  |

## Module identity strategy

A forbidden module is identified by its **resolved absolute file path with any query suffix removed**
(`stripQuery`), never by a specifier or a name. Three places derive that identity:

1. **Pre-scan (`resolve.ts`, `server-only.ts`).** For each re-export specifier of every TypeScript
   module under `sourceDir`, a per-generation resolver maps the specifier to a _scanned_ module, or to
   nothing. The result is only ever a member of the scanned file set, so the resolver cannot crawl
   `node_modules`. Order: relative path (`./x`, `./x.ts`, `./x.js`, `./dir` → `./dir/index.ts`), then
   Vite `resolve.alias` (string and `RegExp` entries with Vite's own semantics), then TypeScript's
   own `ts.resolveModuleName` for the app's tsconfig `paths` / `baseUrl` with the bundler resolution
   mode. The tsconfig is `tsconfig.app.json`, else `tsconfig.json`, in the app root, or the new
   optional `tsconfig` plugin option (app-relative). No second implementation of Node, TypeScript or
   Vite resolution was written.
2. **Client `resolveId`.** The plugin calls `this.resolve(..., { skipSelf: true })` and checks the id
   Vite actually produced. Path specifiers always take this route; a bare specifier takes it only when
   the resolver already says it names an app module (an alias or a tsconfig path), so ordinary package
   imports pay nothing.
3. **Client `load`.** Every module the client environment loads is checked by id. This is the stage
   that makes an unmodelled resolution form safe: if the pre-scan cannot see an edge, the bundler still
   has to load the target, and the target is refused.

Aliases come from `configResolved` (`resolved.resolve.alias`, the supported source of truth, shared by
all environments). The graph is derived once at `config()` (surrogates must exist before Analog reads
its tsconfig) and again at `configResolved`, when the aliases are known. Re-derivation writes nothing
unless a generated file differs.

## Supported resolution forms

| Form                                                              | Pre-analyzed (taint) | Enforced at resolve |           Enforced at load            |
| ----------------------------------------------------------------- | :------------------: | :-----------------: | :-----------------------------------: |
| `./x`, `../x`, `./x.ts`, `./x.js` → `.ts`, `./dir`                |         yes          |         yes         |                  yes                  |
| `export * from`, `export {…} from`, `export * as n from`, renamed |         yes          |         yes         |                  yes                  |
| Vite `resolve.alias` (string, `RegExp`)                           |         yes          |         yes         |                  yes                  |
| tsconfig `paths`, `baseUrl`                                       |         yes          |         yes         |                  yes                  |
| Query suffixes `?raw`, `?url`, `?inline`, …                       |    n/a (stripped)    |         yes         |                  yes                  |
| `import()` and `@defer` lazy chunks                               |         n/a          |         yes         |                  yes                  |
| Package root and exported subpaths                                |   no (not crawled)   |         no          | yes, via the assertion import (below) |
| Glob imports (`import.meta.glob`)                                 |          no          |         no          |                  yes                  |
| `import { A } from "./a"; export { A };` (import, then export)    |          no          |  yes (the import)   |                  yes                  |
| `export type { … } from`                                          |   ignored (erased)   |         n/a         |                  n/a                  |

Notes:

- A barrel that is only partly server-only is conservative at **module level**: importing any export
  of a barrel that re-exports a forbidden module is refused, as before.
- The tsconfig `extends` chain is followed by TypeScript, but only the root tsconfig file is watched in
  dev; a change in an extended file requires a dev-server restart.
- A change of a Vite alias is a change of `vite.config.ts`, which Vite already answers by restarting
  the server (the plugin is created again).
- The Server Component analyzer (template walking, surrogate generation) still resolves component
  imports **relatively** only; an aliased import of a server-owned child is not a supported
  composition form. That is a component-analysis limit, not a server-only limit, and is unchanged.

## Package behavior

The pre-scan never reads `node_modules`. A package is subject to the invariant through the same
`load` / `resolveId` firewall:

- A package module that asserts `import "@strata-sc/server-components/server-only"` is rejected the
  moment the client environment resolves that import, whatever imported the package, and whether or not
  the package is listed in `clientComponents`. The registry authorizes a _component reference_, never
  a server-only dependency.
- A package barrel (`export * from "./safe.js"; export * from "./server.js"`) fails the same way when
  the server-only file is pulled in; browser-safe roots and exported subpaths of the same package
  build and ship normally.
- Export conditions (`browser` / `import` / `default`) are Vite's: the plugin checks whichever file
  Vite resolved.
- **Truthfulness limits.** In a production build the bundler reports a module's importers only after
  linking, so the plugin records the first parent of each client module in `moduleParsed` (one
  build's worth, cleared at `buildStart`) and reports that chain. In `vite` dev the same information
  comes from Vite's module graph. Under the dev server's pre-bundled dependencies (esbuild) a
  package's internal imports are collapsed into one chunk: the chain then stops at the chunk and the
  importer inside the package is not available. The diagnostic prints what the bundler knew and says
  "unavailable" otherwise; it never guesses.

## Diagnostics

```
[strata] Server-only module entered the browser graph: src/app/product/index.ts
Imported from: src/app/product/add-to-cart.component.ts
Reason: it re-exports a server-only module: src/app/product/index.ts → src/app/product/data-barrel.ts →
        src/app/product/product.repository.ts, which declares `import "@strata-sc/server-components/server-only";`. …
Import the browser-safe exports from a module that does not re-export server-only code, or move the
dependency behind the Server Component boundary.
Import chain (the bundler's first importer at each step): index.html → src/main.ts → … → src/app/product/add-to-cart.component.ts → src/app/product/index.ts
```

```
[strata] Server-only module entered the browser graph: node_modules/@strata-test/kit/dist/server.js
Imported from: node_modules/@strata-test/kit/dist/barrel.js
Reason: the importer asserts server-only, but the pre-scan of sourceDir did not register it (it lives
        outside sourceDir, for example in an installed or linked package, …). A package is not exempt from
        the server-only contract because it is listed in clientComponents or installed from npm.
Move the module behind the Server Component boundary, or into sourceDir … remove that import from its browser entry points.
Import chain (…): index.html → … → node_modules/@strata-test/kit/dist/barrel.js → node_modules/@strata-test/kit/dist/server.js
```

Rules: app files print app-relative; a dependency prints from its last `node_modules/` segment; a file
outside the app root and outside `node_modules` prints only its file name; nothing prints a source
body, a value, a header, a token or an environment variable. The chain is capped at 12 steps and
cycle-safe. When the bundler reports no importer the line reads `unavailable (the bundler did not
report an importer for this module, e.g. it was reached through a glob import)`.

## Development graph recovery

The transactional regeneration of the previous releases is unchanged: the next graph is analyzed
completely, the surrogates are synchronized, and only then is the graph swapped in; on failure the
client environment fails closed. New in this change: the resolver is rebuilt with every generation,
so a classification can never outlive the sources or the tsconfig that produced it, and an edit of
the governing tsconfig file is treated as a graph-relevant event (implemented; not exercised by a live
scenario in this change).

`pnpm test:server-component-dev` scenario **O** drives it live over a barrel that re-exports a module
through a Vite alias: the module is public (positive control), gains the assertion (the barrel
becomes forbidden through the alias, with the aliased chain in the server log), an island imports the
barrel (document reload, island does not hydrate, diagnostic names the island), the import is removed
(recovery), the assertion is removed (the island may import the barrel and hydrates), the assertion is
reintroduced (the firewall engages again), a re-export cycle terminates and stays forbidden, and
invalid syntax in the barrel followed by its correction leaves the classification right. No canary is
in any response or HMR frame while the module is server-only.

Finding recorded while building scenario O (not caused by this change; reproduced on the baseline
plugin): `@analogjs/vite-plugin-angular` 2.7.2 keeps the last compiled output of a `.ts` file that
dropped out of its TypeScript program, so a module that an island imported illegally and then
stopped importing can be served stale if it is requested directly (outside any importer) after it
changes. The Strata classification is correct in that state (the firewall decision is fresh); the
stale bytes are Analog's compile cache. The scenario therefore exercises modules through their
importers. This is recorded as a remaining risk, not worked around.

## Consumers and controls

Qualification entry points and what they prove:

- `pnpm test:server-component-server-only`: real production builds of the Analog fixture. Legal
  control: a Server Component using a marked repository, an island importing a shared module through
  relative, tsconfig-path (`@app/*`) and Vite-alias (`~app`) specifiers, and a type-only aliased
  re-export. Illegal shapes (each must fail with the intended diagnostic, the intended module and the
  intended importer): relative, tsconfig path, Vite alias, aliased `?raw`, tsconfig path → index
  barrel → Vite-alias barrel → repository, relative directory-index barrel, a re-export cycle
  containing an aliased re-export, plus the earlier direct, dynamic, barrel, chained barrel, `?raw`,
  `?url` and `@defer` shapes. Browser output is checked for the canary after each failure.
- `pnpm test:server-component-dev`: scenario O above, in addition to H, H2 and I.
- `pnpm test:server-component-package-consumer`: the packed tarball in an npm project outside the
  workspace (TypeScript 6.0.3 and 5.9.2 strict declarations, `skipLibCheck: false`), with consumer-owned
  `paths` and Vite alias, a plain ESM package `@strata-test/kit` (browser-safe root and `./safe`,
  server-only `./server`, barrel `./barrel`) and the Angular partial-compiled
  `@strata-test/angular-widgets` extended with a `./leaky` entry whose component asserts server-only
  and is registered in `clientComponents`. The registered leaky island, the server-only subpath, the
  package barrel, an aliased chained barrel through a directory index and an aliased `?raw` all fail
  the production build with the intended diagnostic and no marker; the legal control (browser-safe
  package root and subpath, aliased shared module, type-only re-export) builds, and the package's
  browser-safe marker reaches the browser while no server-only canary does.

Synthetic canaries are used everywhere; nothing here is a real secret.

## Cost

Measured on the Analog fixture (84 TypeScript modules under `sourceDir`), 15 runs of the whole
graph build (`buildServerComponentGraph`, in-process, files already read): median 13.1 ms with the
relative-only resolver (the previous algorithm) and 11.7 ms with the alias and tsconfig resolver
(including parsing the tsconfig once per generation); the difference is inside the run-to-run noise
(min 8.0 vs 9.4 ms, max 69.9 vs 17.7 ms). The resolver is bound to the scanned file set, and its
TypeScript resolution cache lives and dies with one generation. Parent tracking during a production
build is one map entry per client module. No claim of a build-time improvement or regression is made
beyond this: a whole-build comparison was not part of this measurement.

## Remaining risks

- Glob imports and import-then-export barrels are caught only at load time (no preemptive taint).
- Packages are enforced through their assertion import; a package that leaks server data _without_
  asserting server-only is not detected. There is no crawl of `node_modules`, by design.
- Dev pre-bundled dependency chunks hide the original importer inside a package.
- Analog's compile cache can serve a stale output for a module that left its TypeScript program.
- Only the root tsconfig file is watched in dev.
- The consumer harness showed an intermittent, pre-existing-looking `JIT compiler unavailable`
  failure of the very first Node SSR request in 2 of 6 full runs; it did not reproduce in 12 isolated
  rebuilds of the same installed consumer, and the runs that failed had no relationship to the
  graph checks (the build itself succeeded). It is recorded, not explained.
- Real application adoption, deployment and streaming SSR remain unqualified; seamless SPA navigation
  into Server Component subtrees remains unsupported; Strata 1.0 is not qualified.

## Local qualification results

All run sequentially on the feature branch (macOS, Node 22), exit code 0:
`pnpm build`, `lint`, `typecheck`, `test` (305 unit tests in the package), `format:check`,
`test:release`, `test:performance-tools`, `test:analog`, `test:package-consumer`,
`test:analog-packed-di-consumer`, `test:full-stack-package-consumer`,
`test:server-component-package-consumer` (TypeScript 6.0.3 and 5.9.2 declarations), `test:server-components`,
`test:server-component-navigation`, `-defer`, `-server-only`, `-security`, `-request-context`,
`-authorization`, `-failures`, `-ssr-response`, `-dev`, `test:server-components:cloudflare` (local
workerd), `test:www:server-components`, `test:relay:server-components`, the website Playwright suite
against a fresh Nitro server on a free port, `pnpm www:build:cloudflare` (build only), `entwine check`
and `entwine build` (`@entwine/cli@0.5.1`), `pnpm changeset status` and `npm pack --dry-run`.

Not run: `test:full-stack-deployed-cloudflare`, `test:server-components:deployed-cloudflare` and the
Pages deploy job (they need deployment credentials); `test:full-stack-performance*` and
`test:consumer:types` (extended workflow, not part of this change). Nothing was published, deployed
or tagged.
