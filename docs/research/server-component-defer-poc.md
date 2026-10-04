# Server Components and Angular `@defer` / incremental hydration

Evidence report. Recorded 2026-10-04 on branch `feat/server-component-defer`, baseline `12d608e`
(`main`, merge of PR #42). Written by hand; `pnpm test:server-component-defer` (Node),
`pnpm test:server-components:cloudflare` (workerd) and `pnpm test:relay:server-components`
reproduce every positive observation below. The unsupported shapes were measured with temporary
fixture Server Components that the build now rejects; the analyzer unit tests encode them.

**Question.** Where may Angular's `@defer` be used under a Strata Server Component, who owns its
hydration, and do hydrate triggers keep their meaning without shipping the Server Component?

**Verdict.**

```text
@defer inside a [strataClient] component's own template      GO   (Angular owns it)
@defer anywhere in a server-owned template                   NO-GO → build error (Strata)
```

Strata Server Components coexist with Angular incremental hydration inside explicit client
boundaries. Strata does not implement incremental hydration, a defer scheduler or event replay.

## Two hydration layers

```text
SERVER OWNED                                     browser
DeferShowcaseServerComponent  @ServerComponent      ✗   (surrogate: empty template)
  └ DeferServerChildComponent  ordinary              ✗
      ├ <defer-interaction-panel [strataClient]>     ✓   Layer 1: Strata hydrates the root
      │     @defer (on interaction; hydrate on interaction)
      │       └ DeferInteractionWidgetComponent      ✓   lazy chunk, Layer 2: Angular
      └ <defer-viewport-panel [strataClient]>        ✓   Layer 1
            @defer (on viewport; hydrate on viewport)
              └ DeferViewportWidgetComponent         ✓   lazy chunk, Layer 2
```

- **Layer 1.** `StrataIslandHost` hydrates each explicit `[strataClient]` root as soon as the
  Server Component host renders, after protocol v1 preflight. This is unchanged: Strata does not
  hydrate a root lazily.
- **Layer 2.** Inside that root, Angular's own `@defer` blocks keep their SSR main content
  dehydrated and hydrate it on their own triggers, with their own lazy chunks and event replay.
  Strata never parses or controls that template.

## Exact tuple

Angular 22.1.7 (`@angular/build` 22.1.8), Analog 2.7.2, Vite 8.3.0, Nitro 2.13.4, Node 22.23.1,
Playwright 1.62.1 (Chromium headless shell 151), Wrangler 4.135.0 (workerd, compatibility date
2026-09-21, no flags). Hydration configuration: `provideClientHydration()` only. Angular 22 adds
`withIncrementalHydration()` (and with it event replay) unless `withNoIncrementalHydration()` is
passed; neither is passed. No deprecated Angular API and no `ɵ` API is used.

## Finding: Analog 2.7.2 builds the SSR graph with `ngServerMode = false`

The first measurement rendered the **placeholder** of every `@defer (hydrate …)` block in SSR,
including inside client islands, and the server log showed
`ERROR ReferenceError: IntersectionObserver is not defined` (the server ran `on viewport`).

Cause, in `@analogjs/vite-plugin-angular` 2.7.2 (`angular-build-optimizer-plugin.js`): production
builds get ``define: { ngServerMode: `${!!userConfig.build?.ssr}` }``. Analog 2.7.2 builds client and SSR
in one multi-environment `vite build`, where `build.ssr` is false, so the define is `false` for the
SSR environment too. Analog's `serverModePlugin` rewrites `ngServerMode` to `true` only in files
whose id ends in `core.mjs` or `platform-server.mjs`; Angular 22 keeps the defer runtime in
`@angular/core/fesm2022/_debug_node-chunk.mjs`. In the SSR bundle, `ɵɵdeferHydrateOnInteraction`
lost its server branch (`triggerDeferBlock` on the server) and `shouldAttachRegularTrigger` its
`ngServerMode` branch, so SSR treated hydrate triggers like browser triggers.

Fix used by the fixture and Relay, in their own `vite.config.ts` (no Strata API, no Angular API):

```ts
environments: { ssr: { define: { ngServerMode: "true" } } },
```

With it, the SSR chunk keeps Angular's server branch, SSR renders main content with `ngb` and
`jsaction`, and `/server-component-defer` logs no server error. This is independent of Strata: it
applies to any `@defer (hydrate …)` in an Analog 2.7.2 production build. Without it the SSR of
`/server-component-defer` was measured rendering both placeholders, which the SSR checks of `pnpm
test:server-component-defer` reject. Not reported upstream from this branch.

## Characterization (before any Strata change)

Temporary `@ServerComponent()`s, one per route, production build, Nitro `node-server`, Chromium.
"SSR" is the HTML before JavaScript; "browser" is after load, then after clicking the block content.

| Case | Template (server-owned)                                                 | SSR (with the fix)                                                                                       | Browser                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B    | `@defer (on interaction) { <server-only-details /> } @placeholder {…}`  | placeholder                                                                                              | Nothing can ever load the main content: the details component is only in the SSR graph (its own SSR chunk), the surrogate has no block. Clicks do nothing, no error. Dead UI. |
| C    | `@defer (hydrate on interaction) { <server-only-details /> }`           | main content, `ngb="d0"`, `jsaction="click:;keydown:;"`, `__nghDeferData__`, event contract bootstrapped | Each click: `pageerror: Cannot read properties of null (reading 'hydrating')` (Angular's replay calls the block registry, which is null: no browser component activated it).  |
| C2   | C plus an island with its own `hydrate on interaction` in the same host | as C                                                                                                     | The island activates Angular's runtime; clicking the server-owned block now hydrates nothing, silently, forever (`awaitParentBlock` on a block no view registers).            |
| D    | `@defer (hydrate on interaction) { <boundary-counter [strataClient]> }` | main content; the island host has `ngh` and `ngb="d0"`                                                   | **`StrataIslandHost` hydrated the island on load** (1 created before any interaction): the trigger is violated. Each click also logs the Angular `TypeError` above (twice).   |
| E1   | `@defer (hydrate never) { <server-only-details /> }`                    | main content, no `ngh` inside                                                                            | Static, no error, no code. **Without the Analog fix: SSR renders the placeholder**, which nothing can replace.                                                                |
| E2   | `@defer (hydrate never) { <boundary-counter [strataClient]> }`          | main content; the island host has the boundary attributes but **no `ngh`**                               | `StrataIslandHost` hydrated it anyway, without a hydration annotation: Angular rendered the component a second time into the host (`IncrementCount: 0IncrementCount: 0`).     |

Graph isolation held in every case: the server-only details component, the parents and their
markers were absent from the browser output. No case needed the Server Component in the browser,
and none could work without it.

Under Analog's default config (no fix), B–E2 all rendered their placeholder in SSR, so D and E2
created no island and E1 was a permanently dead placeholder.

**Decision.** Angular owns `@defer` only inside client-owned graphs. A server-owned template has no
client representation that could honour a defer block, so every `@defer` there fails the build,
whatever its triggers. `hydrate never` is not carved out: its SSR result depends on the
application's hydration and build configuration (E1 above), which the analyzer cannot verify, and
it gains nothing over rendering the content directly.

## Analyzer diagnostics

The Server Component analyzer already walks every server-owned template (root, ordinary children at
any depth, nested Server Components) with `@angular/compiler`'s `parseTemplate`. It now overrides
`visitDeferredBlock` and fails at the block's position. The message names the component path, says
the owner is absent from the browser graph, adds one shape-specific reason, and points to
`[strataClient]`:

| Shape                                            | Reason in the message                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| contains `[strataClient]` (main, placeholder, …) | Strata hydrates every boundary under a Server Component when the page loads; the triggers would not be honoured |
| contains `[strataClient]`, `hydrate never`       | Angular writes no hydration annotation for it, yet Strata would hydrate it, rendering it a second time          |
| `hydrate never`, no boundary                     | SSR main content vs placeholder depends on configuration the build cannot verify                                |
| other hydrate triggers, no boundary              | the server renders main content, but no browser code owns the block; the triggers can never complete            |
| no hydrate trigger                               | the server renders the placeholder (if any) and nothing can ever load the main content                          |

The walk still stops at `[strataClient]`: a client component's own `@defer` is never read.

## Supported path: measured

`/server-component-defer` (fixture), production build.

**Bundle (Vite client build).** The eager closure, the static imports of the entry and of the
island's chunk (`index`, `_debug_node-chunk`, `server-component-defer.page`, `islands`), contains
neither widget marker. Each widget is its own chunk, reached only by a dynamic `import()` from the
island's chunk. The chunks are identified by marker search, never by file name. Server-owned
markers are absent from `dist/client` and `dist/analog/public`; every defer marker (server parent
and child, island, both widgets) is in `dist/ssr` and `dist/analog/server`.

**SSR.** Both islands carry protocol v1 attributes and their own `ngh`. Both widgets' main content is
rendered (not the placeholder); the interaction widget's host carries `ngb` and
`jsaction="click:;keydown:;"`; the page bootstraps Angular's event contract for `click`.

**Browser (Node and workerd, identical results).**

| Step                        | Observed                                                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| load                        | 2 islands created (Layer 1); neither widget constructed; no loaded script contains a widget marker; `ngh` left only on the server-owned child and the two dehydrated widget hosts                                             |
| one click, interaction      | only `defer-interaction-widget.component-*.js` requested; widget constructed once; **`Expanded: 1`**: the click that triggered hydration was replayed (one click, one effect); host, button and output text are the SSR nodes |
| second click                | `Expanded: 2`; the viewport widget's chunk still not requested                                                                                                                                                                |
| scroll into view (1000×700) | only `defer-viewport-widget.component-*.js` requested; widget constructed once; host and button are the SSR nodes; `Acknowledge` → `Acknowledged: 1`                                                                          |
| end                         | only `defer-server-child` keeps `ngh` (server-owned, never hydrated by design); no `ngb` left; no console error or warning, no page error, no server error                                                                    |

**Protocol v1 still gates the island.** With `data-strata-protocol="2"` on the interaction island
(Playwright response interception), the preflight refuses the whole host before any root exists.
Clicking the widget then hydrates nothing and requests no deferred chunk; the SSR DOM stays. Angular
also logs `Cannot read properties of null (reading 'hydrating')` for that click, the same Angular
behaviour as case C: its replay contract sees an `ngb` block that no view registered. Recorded, not
asserted.

**Fail closed in the real build.** The Node run writes two temporary Server Components into the
fixture (an ordinary `@defer`; a `[strataClient]` under `hydrate on interaction`). Each `vite
build` exits non-zero in the plugin's `config` hook with the diagnostic at `file:10:14`.

**Cloudflare.** Same fixture, `BUILD_PRESET=cloudflare-pages`, `wrangler pages dev`: SSR main
content and `ngb`, both island roots, interaction (lazy chunk on click, `Expanded: 1`), viewport
(lazy chunk on scroll), DOM reuse, no browser or Worker error. The defer markers pass the Worker
and browser graph scans.

**Relay.** `RolloutSimulatorComponent` (the release gate's `[strataClient]` island) owns
`@defer (on interaction; hydrate on interaction)` around a new `RolloutWavePlanComponent`. The
wave plan reads only the island's server props, so its dehydrated markup is never stale. SSR renders
it with `ngb`; Relay's Playwright suite sees no script containing its marker before the first click,
then one click pins it (replayed) and exactly one script carries the marker.

## Limitations

- Analog 2.7.2 needs the `ngServerMode` SSR define above for any incremental hydration.
- Angular Router navigation into a Server Component route still renders the empty surrogate (no
  island, so no defer block). Unchanged; out of scope.
- An island refused by the protocol preflight leaves Angular's replay contract on its dehydrated
  blocks; interacting logs Angular's `TypeError` (nothing hydrates).
- Only `hydrate on interaction` and `hydrate on viewport` are qualified. Other triggers
  (`idle`, `hover`, `timer`, `immediate`, `when`) are Angular's and untested here.
- A deferred dependency's inputs bound to island state that changes before the block hydrates are
  not updated while dehydrated (Angular's incremental hydration semantics). Relay binds server
  props only.

## Reproduce

```bash
pnpm build
pnpm test:server-component-defer
pnpm test:server-components:cloudflare
pnpm test:relay:server-components
pnpm --filter @strata-sc/server-components test
```
