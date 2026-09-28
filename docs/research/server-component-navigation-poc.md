# Server-component navigation PoC

Evidence report for the second Server Component experiment. Recorded 2026-09-26 on branch
`feat/server-component-navigation-poc`, baseline `1d7293a` (`main`, merge of PR #23). Written by
hand; `pnpm test:server-component-navigation` reproduces every observation below.

> **Path note (2026-09-28).** `StrataIslandHost` now lives in the private
> `@strata-sc/server-components` package, which writes no globals. The
> `window.__STRATA_ISLAND_PROBE__` counters described below moved to the fixture's
> `src/server-components/probe.ts` (`provideIslandProbe()`), which counts the island host views
> attached to the `ApplicationRef` and their destruction. The results below are as recorded.

**Question.** Can a route containing a Strata Server Component take part in navigation without
shipping the server component implementation to the browser? Two mechanisms are compared: a full
document navigation, and an Angular Router client-side navigation.

**Verdict: CONDITIONAL GO.**

```text
initial SSR (direct load)       ✓
document navigation             ✓   GO
Angular Router navigation       ✗   NO-GO: no supported seam
```

Document navigation to a server-component route behaves exactly like a direct load. The server
renders a new document, the island hydrates onto the server nodes, and nothing server-only reaches
the browser. An Angular Router navigation to the same route completes without any error and
renders the generated surrogate. The surrogate is an empty `<product-details></product-details>`.
There is no server request, no server subtree and no island. Angular 22, Analog 2.7 and Vite 8
offer no public seam that lets a client transition obtain a server-rendered subtree and hydrate it.
The overall GO is conditional on server-component routes being reached by document navigation only.

No `packages/*` change was made, and no API was published.

## Exact tuple

Unchanged from the [graph PoC](server-component-graph-poc.md#exact-tuple): `@angular/*` 22.1.7,
`@analogjs/*` 2.7.2, Nitro 2.13 (`node-server`), Vite 8.3.0, TypeScript 6.0.3, Playwright 1.62.1
(Chromium). The Analog fixture's production build is used throughout.

## Current graph model (from PR #23, unchanged)

```text
@ServerComponent() module
  ssr/Nitro graph    → real component + ProductRepository + server-secret
  client graph       → generated surrogate: same selector, template "", StrataIslandHost
                       + client references (AddToCartComponent)
initial document     → SSR HTML with ngh annotations → surrogate hydrates without claiming
                       the server children → StrataIslandHost hydrates each [data-strata-client]
                       as its own root (createComponent({ hostElement }))
```

The surrogate has nothing to render on the client. Every server-rendered node it carries comes
from the document that bootstrapped the application.

## What was added

| File                                                                    | Role                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/analog-fixture/src/app/pages/server-component-navigation.page.ts` | Origin page `/server-component-navigation`: `<h1>Server Component Navigation Probe</h1>`, a plain `<a href="/server-component">Document navigation</a>` and an `<a routerLink="/server-component">Router navigation</a>`. The same destination, reached two different ways. |
| `apps/analog-fixture/src/app/pages/server-component.page.ts`            | One addition: `<a routerLink="/server-component-navigation">Leave (router)</a>` outside `<product-details>`, so the router can leave a hydrated server component.                                                                                                           |
| `apps/analog-fixture/src/server-components/islands.ts`                  | Fixture-only counters `window.__STRATA_ISLAND_PROBE__ = { created, destroyed }`, incremented where `StrataIslandHost` creates and destroys island `ComponentRef`s. No behaviour change.                                                                                     |
| `apps/analog-fixture/src/server-components/probe.ts`                    | Fixture-only `provideNavigationProbe()` (browser only): it records `NavigationStart/End/Cancel/Error` into `window.__STRATA_ROUTER_PROBE__`. It is registered in `app.config.ts`.                                                                                           |
| `tools/server-components/lib/harness.ts`                                | Private helpers extracted from `run.ts`: the check log, fixture build, graph scans and production server. `run.ts` uses them with the same checks (36).                                                                                                                     |
| `tools/server-components/lib/navigation.ts`, `navigation.ts`            | Chromium flows and the runner behind `pnpm test:server-component-navigation`.                                                                                                                                                                                               |

The two counters are separate globals on purpose. A first version shared one `probe.ts` module
between the app entry and the lazy page chunk. Rolldown then split Angular into three shared chunks
(4 → 6 client files, +3 KB). Keeping `islands.ts` self-contained restores the PR #23 chunk layout:
4 client chunks, one `@angular/core` copy, PoC − control = +2,280 B.

## How the two navigations are told apart

A changed URL proves nothing, so every flow records three independent signals:

1. **JavaScript realm sentinel.** Before the click the runner sets
   `window.__STRATA_NAVIGATION_SENTINEL__`. A new document loses it. A client navigation keeps it.
2. **Navigation Timing.** `performance.getEntriesByType("navigation")[0]` names the document that
   is currently alive, and how it was loaded (`navigate`, `back_forward`).
3. **Network.** Every request carries the phase it was issued in, together with its resource type,
   its `isNavigationRequest()` flag, and whether its response body contains server-rendered product
   data (`Product 42`).

The router probe adds a fourth signal: its event log restarts in a new document.

## Direct-load baseline (regression)

`GET /server-component`, as in PR #23. `pnpm test:server-components` still passes all 36 checks:
the control leak, the absence of browser markers, the server markers, SSR, hydration by DOM
identity and the click. The navigation runner repeats the essentials:

| Check                                          | Result |
| ---------------------------------------------- | ------ |
| SSR HTML has `<h1>Product 42</h1>`, `Count: 0` | ✓      |
| SSR HTML carries no server-only marker         | ✓      |
| Island hydrates onto the SSR nodes (identity)  | ✓      |
| No `[ngh]` left; click → `Count: 1`            | ✓      |
| No console errors                              | ✓      |

## Document navigation: GO

`/server-component-navigation` (fresh, hydrated) → click `Document navigation`.

| Observation                                                                        | Result                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| Request `GET document /server-component`, `isNavigationRequest()`                  | ✓                                           |
| Sentinel after navigation                                                          | **gone** (new realm)                        |
| Navigation Timing entry                                                            | `/server-component (navigate)`              |
| Router events                                                                      | restart: `start /server-component`, `end …` |
| New document HTML has `<h1>Product 42</h1>`, `Server rendered product`, `Count: 0` | ✓                                           |
| New document HTML carries no server-only marker                                    | ✓                                           |
| Island hydrates; no `[ngh]` left; 1 article, 1 island                              | ✓                                           |
| `Count: 0` → click → `Count: 1`                                                    | ✓                                           |

Network during the navigation: the destination document (carrying the server-rendered product),
then `index-*.js`, `index.page-*.js` and `server-component.page-*.js`. These are the same scripts
as a direct load.

**Back** (`page.goBack()`): the origin was _reloaded_ as a new document (sentinel absent, entry
`back_forward`). Headless Chromium did not restore it from the back/forward cache here. The origin
is shown, and no `product-details`, `add-to-cart` or product text is left. There are no errors.

**Re-entry** (origin → destination → origin → destination): the second arrival is again a new
realm (`/server-component (navigate)`). It holds exactly one hydrated island (`created: 1` in that
document). The count is `Count: 0` on entry, and two clicks give `Count: 1`, then `Count: 2`: one
handler, one increment per click. The whole flow logs no console errors, warnings or page errors.

## Angular Router navigation: NO-GO (measured, not assumed)

A fresh `/server-component-navigation`, with the sentinel set → click `Router navigation`.

| Recorded                | Value                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Route URL               | `/server-component`                                                                                      |
| Router completion       | `NavigationStart /server-component` → `NavigationEnd /server-component` (no error)                       |
| Document reload         | **none**: the sentinel is kept, and Navigation Timing is still `/server-component-navigation (navigate)` |
| Server component host   | 1 `<product-details>`, **0 child elements**                                                              |
| Server-rendered article | absent                                                                                                   |
| `Product 42`            | absent                                                                                                   |
| `AddToCart`             | absent (no `<add-to-cart>` element)                                                                      |
| Hydration state         | nothing to hydrate: 0 `[ngh]`, 0 `[data-strata-hydrated]`, islands `created: 0`                          |
| Console warnings/errors | **none**, so the failure is silent                                                                       |

The resulting DOM (production build):

```html
<app-root ng-version="22.1.7" ng-server-context="ssr-analog"
  ><router-outlet></router-outlet
  ><app-server-component-page
    ><main><product-details></product-details></main>
    <nav>
      <a routerlink="/server-component-navigation" href="/server-component-navigation"
        >Leave (router)</a
      >
    </nav></app-server-component-page
  ><!----></app-root
>
```

**Network during the router navigation** (the complete list):

```text
GET script /assets/server-component.page-<hash>.js
```

- _Did Angular only download the client route chunk?_ Yes: one request, the lazy route chunk.
- _Did it call Nitro/the server for data or HTML?_ No. There was no fetch or XHR. The only request
  went to the static `/assets/` file that Nitro serves.
- _Did it perform a document request?_ No.
- _Did any server-rendered payload arrive?_ No. No response contained `Product 42`.

On **Back** (popstate, handled by the router in the same realm) the origin is shown and
`<product-details>` is removed. On **router re-entry** the host is the same empty one, with still
no island. The route chunk is already loaded, so no request is made at all.

The PR #23 limitation is therefore confirmed and pinned by the test. It is not a defect of the
graph PoC. It is the navigation gap this experiment set out to measure.

## DOM lifecycle and island destruction

A direct load of `/server-component` (island hydrated, click → `Count: 1`), then a click on
`Leave (router)`, then `Router navigation` back:

| Step                      | Realm | Islands created / destroyed | DOM                                                     |
| ------------------------- | ----- | --------------------------- | ------------------------------------------------------- |
| loaded, hydrated          | A     | 1 / 0                       | server article + hydrated `<add-to-cart>`               |
| router leave → origin     | A     | **1 / 1**                   | no `product-details`, no `add-to-cart`, no product text |
| router back → destination | A     | 1 / 1                       | empty `<product-details>`, no island, no request        |

When the route is left, Angular destroys the surrogate. Its `DestroyRef.onDestroy` destroys the
island `ComponentRef` (attached to `ApplicationRef` with `attachView`), so no view is orphaned. The
server-rendered nodes are removed along with the surrogate's host element. No errors were logged.
The router cannot bring the subtree back, because the application has no copy of it.

## Public seams investigated

The question asked of each one: _can a client router transition obtain a server-rendered route
subtree and have Angular integrate (hydrate) it, without the server component's implementation in
the browser graph?_

| Seam (public)                                                                                                          | What it gives                                                                                                              | Answer                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Angular Router resolvers, guards, `loadComponent`/`loadChildren`, router events                                        | Data or a component _type_ before activation; lifecycle notifications                                                      | No. Views are always created on the client from a component type. There is no input for pre-rendered DOM. A resolver can fetch data, but rendering that data needs the template in the browser graph.                                                                                                                                                                                                 |
| `RouteReuseStrategy`                                                                                                   | Detach and reattach views created in this document                                                                         | Only reuses a subtree the document already had (direct/document load). It cannot obtain a new one. Not a navigation-to seam.                                                                                                                                                                                                                                                                          |
| Analog `.server.ts` `load` (resolver fetching `/_analog/pages/<route>` JSON through `HttpClient` on client navigation) | Plain serializable data per route, from the server, on router navigation                                                   | Transport only. The data still has to be rendered by a client component, which puts the rendering implementation in the browser. That turns a server component into "client component + server loader". It is not a server-rendered subtree.                                                                                                                                                          |
| Analog server functions (`serverFn`, `injectServerFn`, `/_analog/fn/<id>`)                                             | Plain JSON results of server code, TransferState seeding                                                                   | Same as `load`: data, not a rendered subtree.                                                                                                                                                                                                                                                                                                                                                         |
| Analog `renderStream` (streaming SSR, RFC shipped in the router package)                                               | Progressive document streaming                                                                                             | Document-level only. It also string-patches `@angular/core` (see below). It has no client-navigation payload. Analog 2.7.2 ships no server-component request path; the phrase appears only in the RFC text.                                                                                                                                                                                           |
| Nitro server routes                                                                                                    | Any HTTP response, for example the HTML of a route rendered on demand                                                      | The server side is feasible. What stays unsolved is integrating the result into Angular in the browser.                                                                                                                                                                                                                                                                                               |
| Angular `createComponent({ hostElement })` + `provideClientHydration()`                                                | Hydrates a root component onto existing DOM when the host has an `ngh` annotation and the `ngh` data is in `TransferState` | Only for DOM and `ngh` data from the **bootstrap document**. `withDomHydration()` enables hydration from the document's `TransferState` at environment init, `cleanupDehydratedViews` runs after first stability, and the `ngh` table lives under `NGH_DATA_KEY` (`__nghData__`), which is **not** in any public `.d.ts`. Feeding it a second payload would require DOM injection plus a private key. |
| `@defer` / incremental hydration (`withIncrementalHydration`)                                                          | Hydrates server-rendered defer blocks of the initial document later                                                        | Initial document only. On client navigation a `@defer` block renders on the client from its dependency chunk, which would ship the implementation.                                                                                                                                                                                                                                                    |
| Vite (Environment API)                                                                                                 | Build-time graph split (already used)                                                                                      | No runtime role in navigation.                                                                                                                                                                                                                                                                                                                                                                        |
| Document navigation (plain `href`)                                                                                     | A new SSR document, and Angular hydrates it at bootstrap                                                                   | **Yes.** This is the supported seam, and it is the one PR #23 already relies on.                                                                                                                                                                                                                                                                                                                      |

### Unsupported / private seams (recorded, not built on)

- `NGH_DATA_KEY` / `__nghData__`, `retrieveHydrationInfo`, `enableRetrieveHydrationInfoImpl` and
  `cleanupDehydratedViews` are Angular internals (unprefixed inside the FESM chunks but absent from
  the public typings). They would be needed to hydrate a second server payload.
- `IS_HYDRATION_DOM_REUSE_ENABLED` and `PRESERVE_HOST_CONTENT` are private tokens.
- Analog's `deferStreamingPlugin` patches `@angular/core` strings (`applyDeferBlockState`,
  `collectNativeNodesInLContainer`). That is renderer patching.
- Any `fetch` → `innerHTML`/`DOMParser`/`replaceChildren` insertion followed by a hydration
  attempt. It would only show that HTML can be copied into the DOM (excluded by the brief).

None of these is imported or used by authored code.

## Candidate strategy attempted

**None.** No public seam passed the question above, so no SPA candidate was built. Every
remaining route would need a private hydration key, DOM injection, or a patched renderer. Each is
excluded, and none would show a viable integration. The brief also allowed an isolated
micro-experiment, but it was not needed: the limitation is fully explained by the public API
surface and the installed sources.

## Graph leak result

| Check                                                                                                                                                 | Result  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Build artifacts: implementation, repository, transitive markers in browser output                                                                     | absent  |
| Build artifacts: client component and control markers in browser output                                                                               | present |
| No browser file named after a server-only module; no `@angular/compiler`                                                                              | ✓       |
| Server output carries all three server-only markers and the client one                                                                                | ✓       |
| **Runtime:** every script loaded across direct load, document navigation, router navigation, Back, re-entry and teardown flows: no server-only marker | ✓       |
| Runtime: loaded scripts contain the client component                                                                                                  | ✓       |

Scripts actually loaded, across all flows: `index-*.js`, `index.page-*.js`,
`server-component.page-*.js`, `server-component-navigation.page-*.js`. Router navigation downloads
the same surrogate chunk, and nothing else.

## Classification

```text
Document navigation:  GO
Router navigation:    NO-GO   (no supported seam; empty surrogate, silent)
Overall:              CONDITIONAL GO

initial SSR          ✓
document navigation  ✓
SPA navigation       ✗
```

The overall GO holds under these conditions:

1. **Server-component routes must be entered by document navigation.** Today nothing enforces it.
   A `routerLink` to such a route "succeeds" (`NavigationEnd`, no error) and shows an empty
   component. That silent failure is the main hazard this experiment found.
2. The conditions of the [graph PoC verdict](server-component-graph-poc.md#verdict) still apply
   (unspecified hydration behaviours, a non-portable build transform, islands as separate roots).
3. Leaving a server-component route through the router is fine: islands are destroyed and no views
   are orphaned. Coming back through the router is not.

## Limitations

- Chromium only, through Playwright, on the Node `node-server` preset. Workers were not attempted.
- Back/forward cache: headless Chromium reloaded the origin on Back. A real browser may restore it
  (or the destination) from the bfcache instead. Both are whole documents, but a bfcache restore of
  the destination was not observed.
- One server component, one island, one route, one navigation shape. There are no nested routes,
  parameters, prefetching or query changes.
- The router probe and island counters are fixture evidence, not a lifecycle API.

## Recommended next step (not implemented)

Make the measured constraint structural: the build should know which routes contain a server
component, and fail (or warn) when a `routerLink`/`Router.navigate` target resolves to one of
those routes, so they are only reached by document navigation. The silent empty surrogate would
then become a build-time error. Nothing here designs that mechanism.

## Reproduce

```bash
pnpm test:server-component-navigation
```

The command does a production build, then graph scans, then starts the production Nitro server.
It runs the direct-load regression in Chromium, then the document navigation flow (with Back and
re-entry), then the router characterization (with Back and re-entry), then the island teardown flow,
and finally the runtime script scan. It exits non-zero on any failed check, including a router
result that differs from the recorded limitation. It runs in CI after `pnpm test:server-components`.
