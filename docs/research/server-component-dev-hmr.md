# Server Component dev server: graph regeneration, reload and HMR semantics

Date: 2026-10-07. Baseline: `main` at `b6b32154f65a5b68a04e1498d3a1c36b56fd1da8` (PR #51 merged).
Scope: `vite` (the Analog dev server) with `strataServerComponents()`. Not in scope: controllers, Angular
Router navigation into a Server Component subtree (NO-GO, unchanged), streaming, publication.

Command: `pnpm test:server-component-dev` (CI step "Server Component dev server"). Fixture route:
`/server-component-dev` (`apps/analog-fixture/src/app/server-component-dev/*`). Harness:
`tools/server-components/lib/dev-harness.ts` (server, edit/restore, request recorder) and
`tools/server-components/lib/dev.ts` (scenarios). Unit tests: `graph.test.ts`, `plugin.test.ts`,
`composition.test.ts`.

## Resolved tuple

| Package                                                                    | Version              |
| -------------------------------------------------------------------------- | -------------------- |
| node                                                                       | 22.23.0              |
| `@angular/core`, `common`, `compiler`, `router`                            | 22.1.7               |
| `@angular/platform-browser`, `@angular/platform-server`                    | 22.2.1               |
| `@analogjs/platform`, `@analogjs/vite-plugin-angular`, `@analogjs/router`  | 2.7.2                |
| vite (fixture), typescript, nitropack (resolved from `@analogjs/platform`) | 8.3.0, 6.0.3, 2.13.4 |
| playwright (Chromium)                                                      | 1.62.1               |

`@strata-sc/server-components` stays `0.0.0`, `private: true`. `@strata-sc/core` and
`@strata-sc/analog` are untouched. No Changeset. No consumer-facing API change:
`strataServerComponents({ root, sourceDir, generatedDir, enabled })` is the same.

## The contract

```
SERVER-OWNED CHANGE   regenerate Strata graph → new server render required → FULL DOCUMENT RELOAD
CLIENT-OWNED CHANGE   ownership graph unchanged → the framework's own update path (Vite / Angular)
INVALID GRAPH EDIT    Strata diagnostic, client graph fails closed
FIX                   graph regenerates, document reloads, no Vite restart
```

A Server Component's implementation is intentionally not part of the browser graph, so it cannot be
hot-patched in the current browser: the only way to show the new implementation is to render it again on
the server. Server-owned change → document reload is the dev contract, not a fallback. No server-subtree
patch protocol, no HTML fragment morphing, no custom WebSocket payload, no Strata client HMR runtime.

## Public Vite hook: `hotUpdate`

Vite 8.3.0 types (`HotUpdateOptions`): `type: "create" | "update" | "delete"`, `file`, `timestamp`,
`modules`, `server`, with `this.environment`. `hotUpdate` is environment-aware and sees creations and
deletions. `handleHotUpdate` receives only `update`s for the legacy mixed graph and is on Vite's
deprecation path. The composition of Server Components changes when a file is created or deleted
(a new `@ServerComponent()`, a deleted `templateUrl` file), so `hotUpdate` is the correct seam. Used only:
`hotUpdate`, `configureServer` (to hold the server), `server.environments[...].hot.send(...)` (the
public `full-reload` and `error` payloads), and `environment.moduleGraph.getModulesByFile` /
`invalidateModule` / `invalidateAll` (public module-graph methods). No Vite internals, no private
module-graph fields, no monkey patches, no WebSocket internals.

Observed call order (Vite 8.3.0, read while diagnosing, not depended upon beyond the documented
behaviour): one watcher event calls `hotUpdate` for the `client` environment first, then each other
environment; the legacy `handleHotUpdate` of other plugins (Analog's) runs inside the `client` pass. So the
plugin (`enforce: "pre"`) computes the pass once, in its `client` call, and keys it by
`type\0file\0timestamp` so the other environments reuse the result. The reload is sent from the **last**
environment's call: one event, one reload message, after every environment's hooks (Analog's compile
included) have been entered.

## Graph snapshot

`ServerComponentGraph` (private, `src/vite/graph.ts`, not exported from the package):

```ts
interface ServerComponentGraph {
  bySource: ReadonlyMap<string, ServerComponentModule>; // authored module → analysis
  bySurrogate: ReadonlyMap<string, ServerComponentModule>;
  serverOnly: ReadonlyMap<string, ServerOnlyModule>; // assertion + re-export taint
  generated: ReadonlyMap<string, string>; // surrogate path → exact contents
  serverOwnedFiles: ReadonlySet<string>; // what a server render depends on
}
```

`buildServerComponentGraph(input)` is pure given the file list and a reader. `diffGraphs(a, b)` reports
surrogates added/changed/removed, server-only added/removed/changed (reason or chain), server-owned files
added/removed, and modules whose forbidden status flipped. `decideReload(...)` and
`syncGeneratedFiles(...)` are pure too, so snapshot A → edit → snapshot B is unit-tested without a
file system (`graph.test.ts`, 23 tests).

### Server-owned files

The analyzer now records, per Server Component: its module; every unmarked local component (any depth,
nested Server Components included); local directives and pipes it imports (the server render runs
them); and every `templateUrl` file. A `[strataClient]` boundary's module is never included. Cached per
component (`AnalysisCache.owned`) alongside the client references.

## Transactional regeneration

```
read each source once (snapshot) → analyze everything → next graph in memory
        │ throws                                  │ ok
 keep committed graph + files            sync generated files → swap graph → clear failure
 mark failure, fail closed
```

`refresh()` replaces the old `rm -rf generatedDir; clear maps; analyze`. An analysis error cannot leave a
half-new graph or a half-written surrogate set. `syncGeneratedFiles` makes `generatedDir` exactly the desired
set: missing → created, different → rewritten, **identical → not rewritten** (no watcher event, no HMR
churn), anything else under the directory (stale surrogates, empty directories) → removed. Production
builds use the same code (`config()` runs one refresh); the stale-file guarantee of the old `rm -rf` is
kept.

## Failed refresh is not "last good"

Keeping the last committed graph is not enough for safety: if an edit adds `import "…/server-only"` to a
module and the refresh then fails, the old `serverOnly` map would silently still allow it. So a failed
refresh sets `failure`, and while it is set the `client` environment **refuses every module of the app**
(`sourceDir` and `generatedDir`) in `resolveId` and `load` with the analyzer's own message, prefixed by one
sentence. Vite answers an already-transformed module from its cache without calling `load`, so on entering
the failed state the plugin calls `client.moduleGraph.invalidateAll()`: every app module is then loaded
again, and refused. Dependencies in `node_modules/.vite` are not app modules and keep working. The
diagnostic is logged and sent as Vite's `error` payload (the overlay). The next successful refresh clears
`failure` and the document reloads. Nothing partial is committed: `bySource`, `serverOnly`, the generated
files and the server-owned set change together or not at all.

## Changed-file classification

`decideReload(file, previous, next, diff, recovered)`, first match wins:

| Condition                                                   | Result                       |
| ----------------------------------------------------------- | ---------------------------- |
| previous refresh had failed                                 | reload (recovery)            |
| any surrogate, server-only or server-owned-file set differs | reload (graph changed)       |
| `file` ∈ server-owned files (before or after)               | reload (server-owned)        |
| `file` ∈ server-only modules (before or after)              | reload (server-only)         |
| otherwise                                                   | none: leave to the framework |

Relevant files: a `.ts` or `.html` under `sourceDir`, or any path in the committed server-owned or
server-only sets (a `templateUrl` outside `sourceDir`). Everything else is ignored by the plugin. The
`client` environment's `hotUpdate` returns `[]` when Strata reloads (the module update is superseded) and
`undefined` otherwise.

## Ordering and the surrogate event

The pass is: refresh → commit → invalidate the `client` modules of the written/removed surrogates and of
every module whose forbidden status flipped → decide → (last environment) reload. When surrogates were
written, Angular must compile them before the reloaded page requests them, and that compile is triggered
by the watcher reporting the generated file through the plugin pipeline, a **separate** later event. The
reload is therefore held until each written surrogate has been reported (two-second fallback if the
watcher never reports it). Events for files under `generatedDir` are recognized and never refreshed
(**no watcher loop**); they only satisfy the held reload, and the `client` call returns `[]` for an
awaited surrogate so Vite's own dead-end propagation does not add a second reload.

## What each environment does

| Edit                                                                 | Strata                           | Browser                                       |
| -------------------------------------------------------------------- | -------------------------------- | --------------------------------------------- |
| `@ServerComponent` source, server child, `templateUrl`               | refresh, reload once             | new document, new realm, fresh SSR, hydration |
| add / swap / remove a `[strataClient]` boundary                      | surrogate rewritten, reload once | new document; only the current islands        |
| client island template/logic, graph unchanged                        | refresh, **no reload**           | framework's own update path (see below)       |
| public module → `import "…/server-only"`                             | server-only set grows, reload    | new realm: module request HTTP 500            |
| barrel starts re-exporting a server-only module                      | taint propagates, reload         | new realm: barrel request HTTP 500            |
| invalid server-owned edit (`@defer`, `(click)`, unresolved boundary) | failure, diagnostic              | overlay; every app module refused             |
| the fix                                                              | refresh ok, reload               | new document; app works                       |
| new `@ServerComponent()` module / deleting one                       | surrogate created / deleted      | after wiring, rendered / page unaffected      |

### What the framework does with a client-only edit

Measured, because "Angular/Vite HMR" depends on Analog's configuration:

- **Analog default, `liveReload: false`** (the stock template and this fixture): every Angular
  TypeScript edit makes Vite log `(client) page reload` and reload the document. Strata sent nothing: the
  server log has no Strata reload line for the edit (`graph refreshed`, graph unchanged). This is the
  framework's behaviour, recorded, not claimed as HMR.
- **`liveReload: true`**: Angular's component HMR updates the island in place: same JS realm (sentinel
  survives), **zero document requests**, one `@ng/component?c=…` module request, component state kept
  (`Clicks: 1` survives), Vite logs `(client) hmr update`. Strata's pass for that edit is the same
  graph-unchanged refresh and sends no reload. The fixture reads `STRATA_DEV_LIVE_RELOAD=on` to enable it
  for this run only.
- **`liveReload: true` and server-owned edits are not qualified.** After an edit to a Server Component
  the SSR render still returns the old text. Reproduced with the plugin disabled (`enabled: false`): the
  SSR module runner keeps serving the previous instance of any edited component under `liveReload`. Calling
  `invalidateModule` for the SSR environment or sending it a `full-reload` did not change that, so neither is
  shipped. Server Component dev is qualified with Analog's default.

## Security behaviour (dev)

- The firewall of PR #49 holds in dev: `resolveId` and `load` consult the _current_ graph. A module that
  starts asserting server-only, or a barrel that starts re-exporting one, is refused on the next request
  with the existing diagnostic (module, importer, reason, chain, fix); `?raw`, `?url` and `import()`
  included. The diagnostic never prints module contents.
- The browser-side `importers` lookup in the `load` backstop threw in dev (`ModuleInfo.importers` is not
  supported by the dev server): it now falls back to the dev module graph, so the diagnostic is the
  Strata one, not a Vite internal error. This was a latent dev bug exposed by this slice.
- **Temporal limit.** Marking a module server-only prevents _future_ browser loads. It cannot revoke bytes
  a realm already received and executed. The old realm is ended by the document reload; the new realm's
  request fails closed. No retrospective secrecy is claimed. The gate separates _before_ (positive
  control: the browser gets the canary) from _after_ (no response or HMR frame since the edit contains
  it).
- Dev errors do not carry source or data: the response bodies of the refused requests were scanned for the
  canaries, and the server-only repository's canary appears in no browser response or HMR frame during any
  scenario (only a hash crosses, as in production).
- Protocol v1 is unchanged; a reload after a server-owned edit renders the same boundary markup.
  `StrataIslandHost` and the failure/recovery contract (PR #51) are untouched.

## Edit scenarios and results

All run by one command against the real dev server (`pnpm test:server-component-dev`); every check below is
a line of its output.

| #   | Scenario                                                                                                                                                                                         | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| A   | initial dev SSR, hydration once, one click = one effect, no canary                                                                                                                               | pass   |
| B   | `@ServerComponent` message A → B: sentinel gone, one document request, one Strata reload, SSR has B and not A, island hydrates once                                                              | pass   |
| C   | ordinary server child edit (root file untouched)                                                                                                                                                 | pass   |
| D   | `templateUrl` grandchild `.html` edit (recursive server-owned)                                                                                                                                   | pass   |
| E   | boundary added: surrogate regenerated, SSR includes it, hydrates, click works                                                                                                                    | pass   |
| E2  | boundary type changed B → C: surrogate imports C only; no B island                                                                                                                               | pass   |
| F   | boundary removed: no client reference, only the root island remains                                                                                                                              | pass   |
| G   | client island edit (default Analog): Strata forces no reload; new label visible; framework's own page reload recorded                                                                            | pass   |
| G2  | client island edit (`liveReload` on): same realm, 0 document requests, state kept, no Strata reload                                                                                              | pass   |
| H   | `import "…/server-only"` added live: old realm replaced; new realm's module request HTTP 500; direct and `?raw` refused; no canary after the edit; island does not hydrate; removing it recovers | pass   |
| H2  | dynamic `import()` of a module marked live fails; `?raw`, `?url` and plain request refused; positive controls before                                                                             | pass   |
| I   | barrel starts re-exporting a server-only module: refused at once with the chain; removal recovers                                                                                                | pass   |
| J   | server-owned `@defer`: analyzer diagnostic in the log and overlay, every app module refused (even cached), fix reloads and recovers                                                              | pass   |
| K   | server-owned `(click)`: same                                                                                                                                                                     | pass   |
| K2  | unresolved `[strataClient]` composition: same                                                                                                                                                    | pass   |
| L   | new `@ServerComponent()` file: surrogate generated; wired into the page: SSR renders it; unwired and deleted: surrogate removed, no failure                                                      | pass   |
| M   | server edit ×2, boundary add, boundary remove: one reload each; one island, one ComponentRef, one click = one effect, no console errors                                                          | pass   |

The working tree is verified byte for byte after the run (every touched path restored; created files
gone; the generated surrogates equal to their pre-test snapshot after each scenario). The server and
Chromium are always stopped (`finally`).

Synchronization is by observable evidence, never a fixed sleep as the primary signal: the JS realm sentinel
disappearing, document requests counted by the browser, SSR HTML polled until it changes, Vite's own log
line, generated files polled, HTTP status of the module request. Short settle windows exist only to assert a
negative ("no second reload") and to let a restore's own reload drain before the next scenario.

### Internals the gate does not assert

No WebSocket payload structure is asserted. The recorder keeps the frames the page received only to scan
them for canaries.

## Timing

`graph refreshed in N ms` is logged per edit. A full source scan with no incremental state:

| App              | Warm refresh (min / median / max, 11 runs) | In-gate refreshes                    |
| ---------------- | ------------------------------------------ | ------------------------------------ |
| `analog-fixture` | 5.6 / 6.6 / 10.8 ms                        | see output of the gate (median 6 ms) |
| Relay            | 3.2 / 3.9 / 5.6 ms                         | 7–19 ms live edit                    |
| `apps/www`       | 1.7 / 1.8 / 2.4 ms                         | n/a                                  |

Trivial, so no cache or incremental analysis was added. End to end, an edit to the document reloaded in
about 200–400 ms on the fixture.

## Relay and website smoke

- Relay (`pnpm relay:dev`, `/release`): SSR, the rollout island hydrates, the range input updates
  (`10% · 480` → `20% · 960 req/min`), no console errors. One server-owned text edit in
  `release-gate.server-component.ts` replaces the document, the SSR HTML has the edit, the island
  hydrates again; the file was restored (and the restore reloaded once more). Refresh 19 ms, then 7 ms.
- Website (`pnpm www:dev`, `/`): the Server Component demo hydrates, one click gives `Interactions: 1`,
  no console errors at load. Not mutated.

## Known limitations

- Analog `liveReload: true` is unqualified for server-owned edits (see above); the default is qualified.
- A plain helper module that a Server Component imports for its logic, and that is neither a component,
  directive, pipe nor marked server-only, is not tracked as server-owned. Editing it takes the client path;
  the next server render picks it up. (Mark it server-only if it must be tracked.)
- A graph that is invalid when `vite` starts fails the start, as before. Only edits while running recover.
- Between a file being saved and the plugin's pass finishing (milliseconds), a request is answered from the
  previous graph; the document reload is sent only after the pass.
- After a failed module load the Angular router may navigate the page to `/`; a recovery reload reloads
  that URL. This is the router's behaviour (the gate navigates back to the route).
- `sourceDir`'s TypeScript and reachable `templateUrl` files only; aliased and package re-exports are not
  propagated by the pre-scan (unchanged, production limitation).
- Streaming, Router navigation into a Server Component subtree, and a deployed environment: unchanged,
  unqualified.

## Verdicts

| Area                            | Verdict                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial dev graph               | **GO**                                                                                                                                                                                                                        |
| Server-owned change refresh     | **GO**                                                                                                                                                                                                                        |
| Client HMR coexistence          | **CONDITIONAL GO** — GO for Analog's default (Strata forces nothing; the framework reloads) and for `liveReload: true` client edits (Angular HMR, same realm); server-owned edits under `liveReload: true` are NO-GO (Analog) |
| Server-only live firewall       | **GO**                                                                                                                                                                                                                        |
| Invalid-edit recovery           | **GO**                                                                                                                                                                                                                        |
| Generated surrogate consistency | **GO**                                                                                                                                                                                                                        |
| **Overall dev/HMR**             | **CONDITIONAL GO** (qualified for Analog's default configuration)                                                                                                                                                             |

This does not certify the 1.0 release item: there is no release candidate, no deployed environment, and
the alias/package re-export limitation remains.
