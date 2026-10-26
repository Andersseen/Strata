# Server-only firewall vs Vite's dependency optimizer (0.9.0)

Date: 2026-10-26
Baseline: `main` at `481976818675519015edddd209b7bd3c4fc3c83d` (`@strata-sc/server-components` 0.8.0)
Branch: `feat/server-components-optimized-dependency-firewall-v09`

## Question

A module that imports `@strata-sc/server-components/server-only` must never become browser-executable code or
browser-accessible source. The pre-scan covers the app's own sources and the documented limitation was that, in `vite`
dev, a package's internal imports are collapsed into a pre-bundled chunk before the module graph sees them. Is that

- (A) a real bypass,
- (B) a safe rejection with incomplete diagnostics,
- (C) a safe result because the optimizer drops unreachable forbidden code, or
- (D) something different under the installed Vite?

## Toolchain tuple

| Component                         | Version                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node (local run)                  | 22.22.0 (repository `engines` asks for >=22.22.3; run with `engine-strict` off, CI uses a newer patch) |
| pnpm / npm                        | 10.30.1 / 10.9.4                                                                                       |
| Vite                              | 8.3.0                                                                                                  |
| Rolldown (Vite 8's bundler)       | 1.2.8                                                                                                  |
| TypeScript                        | 6.0.3                                                                                                  |
| Package under test, installed via | `npm pack` tarball of `@strata-sc/server-components` 0.8.0 plus the fixture, outside the repository    |

## Mechanism

Vite 8 pre-bundles dependencies with Rolldown (`prepareRolldownOptimizerRun`). The optimizer resolves a dependency's
internal imports itself; the Strata Vite plugin's `resolveId` (which rejects the assertion specifier in the `client`
environment) is not part of that bundle. Two further facts, both observed:

- The startup dependency scan does not load files inside `node_modules`: it records bare imports and stops. A scanned
  dependency is therefore first loaded by the **optimizer run**, which Vite performs at server start, before any request.
- The plugin list in `optimizeDeps.rolldownOptions.plugins` is public, and is used by both the scan and the optimizer
  run, ahead of Vite's own dependency plugins.

## Original behavior: reproduced, and it is a bypass (class A)

Fixture: `tests/server-component-optimized-deps/kit` (`@acme/server-kit`), packed and installed with npm into a
temporary app, run with the **installed** plugin tarball. Synthetic markers: `STRATA_FIXTURE_PUBLIC_*` (safe),
`STRATA_FIXTURE_SERVER_ONLY` (explicit server-only module) and `STRATA_FIXTURE_PRIVATE_IMPL` (private implementation
imported by it). They are not credentials.

Dev server, cold cache, firewall as released in 0.8.0 (also the "firewall off" positive control of the new check):

| Browser import                                    | Result before                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@acme/server-kit/secret` (asserts server-only)   | HTTP 200, optimized chunk contains `SERVER_ONLY` and `PRIVATE_IMPL`                   |
| `@acme/server-kit/barrel` (re-exports it)         | HTTP 200, same markers; the app selected only the safe `format` export                |
| `@acme/server-kit/chain` (barrel of a barrel)     | HTTP 200, same markers                                                                |
| `@acme/server-kit/lazy` (`import()` of it)        | HTTP 200, second optimized chunk with the markers                                     |
| root, safe subpath, safe barrel, type-only, cond. | HTTP 200, public marker only (correct)                                                |
| `optimizeDeps.exclude` (served unbundled)         | HTTP 500 (refused), **but** the error payload carried the code frame and `pluginCode` |

So the assertion was ignored for any package module reached through the optimizer. Production builds were already
correct (the plugin's `resolveId` sees every import there). The second row of the last entry is a second, independent
finding: when a server-only package module is served unbundled, Vite's import analysis fails while analysing **that**
module's imports, and Vite's dev error payload (HTTP 500 page and overlay message) then contains that module's source.

## Security invariant

A browser-visible module path that reaches an explicitly server-only module, including through package re-exports,
barrel chains or dynamic imports, is refused before forbidden implementation code can be served, and a refusal never
puts the forbidden source in a response.

## Implemented hardening

1. `optimizer.ts`: a Rolldown plugin added through the public `optimizeDeps.rolldownOptions.plugins` (no new option, no
   private Vite or Rolldown API, no cache filenames). It records any module that imports the assertion during an
   optimizer or scan run and fails the run at `buildEnd`, when the module graph is complete, so the diagnostic can
   name the importers Rolldown reports. A failed run produces no chunk. State lives in the plugin instance and is reset
   at `buildStart`. It resolves nothing, parses nothing and crawls nothing: only modules the optimizer already loads are
   inspected, so cost is a set insertion per assertion import.
2. A `[strata]` dev error is delivered to the browser as its message alone: a Connect error middleware, registered
   by `configureServer` ahead of Vite's own error handler, removes `frame`, `pluginCode`, `loc`, `id` and the stack
   (replaced by the message). Strata diagnostics already use sanitized paths; the payload now matches.
3. A new `server-only-optimized` diagnostic reason. It says the module is part of a pre-bundled dependency, lists the
   importer chain Rolldown knows (for example `chain.js → barrel.js → secret.js`) and says "none known" when the module
   is itself an optimizer entry. It never invents an importer. The app import that started the chain is not recoverable
   through the optimizer and the message says so.
4. CI: `pnpm test:server-component-optimized-deps`.

## Results (`pnpm test:server-component-optimized-deps`, 250+ checks, all passing)

Each negative case must fail with the `[strata] Server-only module entered the browser graph` diagnostic that names the
intended modules, with no private marker in any served body and no absolute path in the diagnostic or the browser error
payload. Syntax-error and unresolved-package controls are required **not** to carry that diagnostic.

| Mode (installed tarball unless stated)                       | Safe cases (root, subpath, safe barrel, type-only, browser condition) | Forbidden cases (server-only subpath, barrel, chained barrel, dynamic import)                |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Positive control, plugin off                                 | n/a                                                                   | **Markers served** (proves the markers exist and the bypass was real)                        |
| Dev, runtime discovery, cold cache                           | allowed, optimized                                                    | dep chunk answers 504, error logged with the Strata diagnostic, no marker                    |
| Dev, runtime discovery, warm cache                           | allowed, optimized                                                    | same (a failed run leaves no cache that serves)                                              |
| Dev, `optimizeDeps.force`                                    | allowed                                                               | refused                                                                                      |
| Dev, HTML entry (startup scan)                               | server starts and serves                                              | **dev server process exits non-zero before serving**, diagnostic names the module            |
| Dev, `optimizeDeps.include` of the entry                     | server starts and serves                                              | process exits non-zero at start, diagnostic printed                                          |
| Dev, `optimizeDeps.exclude`                                  | allowed                                                               | HTTP 500, payload has no frame, no source, no machine path                                   |
| Dev, linked workspace package (symlink outside node_modules) | allowed                                                               | refused (as source: import-analysis path, sanitized payload; with `include`: optimizer path) |
| `vite build` browser graph, source maps on                   | builds; public marker present                                         | build fails with the Strata diagnostic and the module names; no private marker in `dist`     |
| `vite build --ssr` (`noExternal`)                            | n/a                                                                   | **Positive control:** the same markers are in the server bundle                              |

Conditional export: the browser condition (`cond.browser.js`) is selected by the real client resolver and allowed. The
`node` condition file asserts server-only and is never reached from the client graph; no case reaches it, which the
`PRIVATE_COND_NODE` marker scan confirms.

### Semantics worth recording

- A barrel that re-exports a forbidden module is refused even when the app imports only a safe named export. The
  optimizer bundles the whole entry, so a named import does not narrow what is served. This is the existing module-level
  rule; nothing was weakened and no tree-shaking result was relied on.
- One forbidden entry fails the whole optimizer **batch** (Vite's optimizer is all-or-nothing per run): a safe sibling
  discovered in the same run answers 504 until the forbidden import is removed. This is fail-closed collateral, not a
  per-package classification.
- A dependency scanned or `include`d at startup that reaches the assertion makes Vite's first optimizer run reject. Vite
  8.3.0 does not catch that rejection (reproduced with an unrelated generic failing Rolldown plugin), so **the `vite` dev
  process exits with code 1 and the diagnostic**. A dependency discovered after startup fails softly with 504 and a
  logged error. Both are observable failures; neither serves forbidden code. The crash comes from Vite, not from a
  Strata-specific abort, and the report does not present it as a UX improvement.

### Cache and HMR behavior

- A failed optimizer run produces no served chunk, so a previously failed cache cannot serve; a subsequent cold, warm or
  forced start reproduces the refusal (tested).
- The optimizer cache is keyed by lockfile and optimizer configuration, **not by package file contents**. Adding the
  assertion to an already optimized package file in place (no lockfile change) is served from the warm cache until the
  cache is regenerated. Measured, not hidden: `optimizeDeps.force` and a cold start both refuse the changed package, and
  the check asserts this. A real `npm install` that changes the package changes the lockfile and re-optimizes. Strata
  does not attempt to detect it: that would need a content fingerprint of every optimized file.
- Installed package changes may need a Vite restart; this is documented rather than presented as live package HMR.
  App-source firewall behavior (live regeneration, document reload for server-owned edits, fail-closed recovery) is
  unchanged and covered by `pnpm test:server-component-dev`.

## Production, Node, workerd, packed consumer

Production builds are unchanged by the change (the optimizer plugin is inert outside `vite` dev; the error middleware is
registered by `configureServer` only). See the verification matrix in the final section for the suites that were run in
this environment.

## Performance

Single runs of the fixture, safe entry, cold cache then warm cache, start plus first load (`createServer` to last
request of the crawl), plugin firewall on vs off (`enabled: false`): cold 1430 ms off, 1506 ms on; warm 1436 ms off,
1495 ms on. The difference (about 60-75 ms) is within the run-to-run noise of a single sample and is **not** a
benchmark; it contains the TypeScript import of the plugin. No whole-build comparison was made. The mechanism adds one
`Set` insertion per assertion import and one `buildEnd` call per optimizer run, no filesystem access and no parsing.

## Remaining limitations

- Only modules that import the assertion are protected. A package that leaks server data without asserting
  server-only is not detected; there is no `node_modules` crawl, by design. An unmarked third-party package is not
  protected from leaking secrets.
- The app import that started a chain is unavailable under optimization; the diagnostic prints what the optimizer knows.
- A warm optimizer cache survives an in-place edit that adds the assertion (see above).
- Vite 8.3.0's unhandled rejection on a failed first optimizer run terminates `vite` dev at startup.
- One forbidden entry fails the whole optimizer batch.
- Not qualified here: hosted CI, deployed Cloudflare, production adoption. This is not M4 or Strata 1.0 readiness.

## Release-pipeline finding (separate from the feature)

The merged `workflow_run` authorizer (#128) blocked the genuine CI run of its own merge: run
[40225575870](https://github.com/Andersseen/Strata/actions/runs/40225575870) (Release, `workflow_run`, main
`4819768`) failed in "Verify exact main CI result" with `Release blocked: source run is not the repository CI workflow`,
and the "Version or publish" job was skipped. `verifyReleaseRun` compared `run.path` to `.github/workflows/ci.yml@main`;
GitHub reports `.github/workflows/ci.yml` for a push to the default branch. A minimal fix accepts
`.github/workflows/ci.yml` and `…@main` / `…@refs/heads/main` and still rejects other files and refs, with unit tests
(`pnpm test:release`). This keeps issue #117 open until a hosted run authorizes and a Version Packages PR or publish
follows; the exact payload `path` value was not observable from here.
