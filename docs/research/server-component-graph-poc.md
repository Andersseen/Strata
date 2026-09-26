# Server-component graph PoC

Evidence report for the first strict Server Component experiment. Recorded 2026-09-26 on branch
`feat/server-component-graph-poc`, baseline `061b0ef` (`main`, merge of PR #22). Written by hand;
`pnpm test:server-components` reproduces every number and observation below.

**Question.** Can an Angular component render on the server, depend on server-only code, compose an
ordinary interactive Angular child, keep its own implementation and its server dependencies
completely out of the browser graph, while the child actually hydrates and stays interactive?

**Verdict: CONDITIONAL GO.** Yes, in the Analog fixture's production build (and in dev). The server
component, its repository and the repository's transitive server-only import are absent from every
browser artifact. The child ships, hydrates onto the server-rendered DOM nodes (same node identity,
`ngh` consumed by Angular) and counts clicks. There is no DOM injection or client re-render. The
conditions are listed under [Verdict](#verdict): they are about which Angular and Vite/Analog
behaviours the mechanism relies on, not about whether the split exists.

No `packages/*` change was needed, and no public API was added.

## Exact tuple

| Package                         | Version | Role                                                          |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `@angular/core`                 | 22.1.7  | Rendering, hydration, `createComponent`                       |
| `@angular/compiler-cli`         | 22.1.7  | AOT (`NgtscProgram`, driven by Analog)                        |
| `@angular/build`                | 22.1.8  | Loaded by Analog (`@angular/build/private` compilation)       |
| `@analogjs/platform`            | 2.7.2   | Vite environments, Nitro build                                |
| `@analogjs/vite-plugin-angular` | 2.7.2   | Compiles the tsconfig program, serves emitted JS by module id |
| `@analogjs/router`              | 2.7.2   | File routes, `render()` for SSR                               |
| Nitro (`nitropack`)             | 2.13.x  | `node-server` production output                               |
| `vite`                          | 8.3.0   | `client` and `ssr` environments                               |
| `typescript`                    | 6.0.3   | Compiler; also parses sources in the PoC plugin               |
| `playwright`                    | 1.62.1  | Chromium hydration/interaction check (root devDependency)     |

## Where each graph is produced

Read from the installed sources and from the build output, not assumed:

| Graph        | Producer                                                                                                                                                                                                                                                        | Artifacts                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Browser      | Vite `client` environment. Analog's Angular plugin compiles the tsconfig program once and its `transform` hook returns the emitted JS for a module id; ids not in the program are skipped (with a warning if they contain Angular decorators).                  | `dist/client/**`, copied by Nitro to `dist/analog/public/**`         |
| SSR          | Vite `ssr` environment, entry `src/main.server.ts`.                                                                                                                                                                                                             | `dist/ssr/main.server.js`, `dist/ssr/assets/*.page-*.js`             |
| Nitro server | Nitro's own bundler: server routes and plugins, plus the virtual `#ANALOG_SSR_RENDERER` that imports the SSR build. Externals are traced into `dist/analog/server/node_modules` (this is where `@angular/compiler` lives, a side-effect import in `nitro.mjs`). | `dist/analog/server/chunks/**`, `dist/analog/server/node_modules/**` |

Extension points found, and whether they are used:

- **Vite, per environment** — plugin hooks see `this.environment.name` (`client` / `ssr` in Analog).
  An `enforce: "pre"` `resolveId` can send one import to a different module in `client` only. _Used._
- **Analog's program** — only files in `tsconfig.app.json` (and what they import) are AOT-compiled.
  A generated file must exist and be included before Analog reads its tsconfig. _Used._
- **Angular hydration** — the server writes an `ngh` attribute on each component host (the index
  into `__nghData__` in `TransferState`). `ComponentFactory.createComponentRef` calls
  `retrieveHydrationInfo(hostElement, …)` for the root view, then `renderComponent` reads the
  host's component-view annotation. `PRESERVE_HOST_CONTENT` is true under `provideClientHydration()`,
  so `createComponent({ hostElement })` keeps the host's server DOM. _Relied on._
- **`@defer (hydrate never)`** — keeps server DOM dehydrated. Its dependencies are still emitted as
  a client chunk, and the child inside it would stay dehydrated as well. _Not used._

No public Angular seam marks a component "server only". There is also no public way to hydrate part
of a component's view while skipping the rest.

## Mechanism

One private mechanism, in three parts. The build decides which graph gets which module. The page
imports the server component like any other component.

```text
                         SERVER GRAPH  (Vite ssr → dist/ssr → Nitro)
                              │
             ProductDetailsComponent  @ServerComponent() @Component
                    /                 \
         ProductRepository          AddToCartComponent  ← [strataClient] records
                  │                                        selector + plain props
            server-secret.ts

                         BROWSER GRAPH  (Vite client → dist/client, dist/analog/public)
                              │
      ProductDetailsComponent  (generated surrogate: same selector, template "", decls 0)
                              │  hostDirectives: StrataIslandHost
                              │  client references: [AddToCartComponent]
                              ▼
                      AddToCartComponent
```

1. **Declaration.** `@ServerComponent()` is a no-op, fixture-local decorator
   (`src/server-components/server-component.ts`) stacked on `@Component`. It is only a build-time
   mark.
2. **Build transform** (`tools/server-components/vite-plugin.ts`, private). In its `config` hook it
   parses `src/app/**` with the TypeScript API. For each `@ServerComponent()` class it reads the
   `selector` literal and the `imports` identifiers, and generates
   `src/generated/server-components/<path>` (gitignored). That is an ordinary Angular component with
   the same selector, `template: ""`, `hostDirectives: [StrataIslandHost]`, and the server
   component's imports as client references. The fixture-local runtime directory is excluded, so the
   server-side boundary directive never becomes a client reference. In the `client` environment only,
   `resolveId` sends every import of the server-component module to its surrogate. `load` fails the
   build if the real module reaches the `client` environment by any other path. The `ssr`
   environment, and so Nitro, keep the real module.
3. **Runtime** (fixture-local, `src/server-components/`):
   - _Server:_ `StrataClientBoundary` (`[strataClient]="{ productId: product.id }"`) writes
     `data-strata-client="<selector>"` and `data-strata-props="<JSON>"` on the child's host. The
     boundary carries plain data only.
   - _Browser:_ the surrogate hydrates with Angular's normal pass. Its empty template claims none of
     the server-rendered children, which stay in the DOM untouched. In `afterNextRender`,
     `StrataIslandHost` hydrates each boundary as its own Angular root, attached to the same
     `ApplicationRef`:
     `createComponent(type, { environmentInjector, elementInjector, hostElement })`, then
     `setInput(...)` per prop, then `appRef.attachView(...)`. Angular reads the host's `ngh`
     annotation and claims the existing nodes.

The compiled browser output of the page chunk shows the split directly (excerpt, PoC build):

```js
N.ɵcmp = c({ type: N, selectors: [[`product-details`]],
  features: [s([O([M])]), y([k])], decls: 0, vars: 0, template: function (e, t) {}, … });
```

`M` is `AddToCartComponent` and `k` is `StrataIslandHost`. No repository, no secret, no
implementation code.

## Graph before and after

The runner builds the same app twice. The **control** build (`STRATA_SERVER_COMPONENTS=off`) is
ordinary SSR, the "SSR is not a Server Component" case. Every server-only marker must appear in the
browser output there, which proves the scanner detects a leak and that the PoC build's absence
comes from the mechanism and not from tree-shaking by accident.

Markers are consumed at runtime: each passes through a string hash that the rendered
`data-evidence` attribute depends on. A first attempt used `MARKER.length`. The bundler
constant-folded it even in the server output, so the markers vanished from both graphs. That is
exactly the false negative the brief warned about, and it is fixed.

| Marker                                          | Browser, control (plain SSR) | Browser, PoC | Server, PoC |
| ----------------------------------------------- | ---------------------------- | ------------ | ----------- |
| `STRATA_SERVER_COMPONENT_IMPLEMENTATION_MARKER` | present                      | **absent**   | present     |
| `STRATA_SERVER_COMPONENT_REPOSITORY_MARKER`     | present                      | **absent**   | present     |
| `STRATA_TRANSITIVE_SERVER_ONLY_MARKER`          | present                      | **absent**   | present     |
| `STRATA_CLIENT_COMPONENT_MARKER`                | present                      | **present**  | present     |
| `STRATA_ANALOG_CLIENT_CONTROL_MARKER` (index)   | present                      | **present**  | present     |

- Browser = every file under `dist/client` and `dist/analog/public` (JS, `index.html`, and any map or
  manifest; this build emits neither). Server = `dist/ssr` and `dist/analog/server`, including traced
  `node_modules`. In the PoC build the server markers are in `ssr/assets/server-component.page-*.js`
  and `analog/server/chunks/_/server-component.page-*.mjs`.
- No browser file is named after a server-only module.
- `@angular/compiler` (fingerprint `Unterminated quote`) is absent from the browser output and
  present in the Nitro output. The SPEC-003 `nitro.moduleSideEffects` entry is kept.
- **Runtime check:** the scripts Chromium actually loaded for `/server-component`
  (`index-*.js`, `index.page-*.js`, `server-component.page-*.js`) contain none of the server-only
  markers and do contain the client component.

**Transitive leak result:** `server-secret.ts` is reached only through `ProductRepository`. It is
absent from the browser (and present in the control build's browser output), so the split is
transitive for this graph. The surrogate imports only the client references and the island host,
so the real module's import subgraph is never entered.

## SSR result

Direct HTTP request to the production Nitro server (`node dist/analog/server/index.mjs`), no
browser:

```html
<product-details ngh="0"
  ><article data-evidence="514bae4b.e1aa4db3.24984f89">
    <h1>Product 42</h1>
    <p>Server rendered product</p>
    <add-to-cart data-strata-client="add-to-cart" data-strata-props='{"productId":"42"}' ngh="0"
      ><button
        type="button"
        data-product-id="42"
        data-marker="STRATA_CLIENT_COMPONENT_MARKER"
        jsaction="click:;"
      >
        Add to cart</button
      ><output>Count: 0</output></add-to-cart
    >
  </article></product-details
>
```

HTTP 200 `text/html`. The server data and the child's initial state are present before any
JavaScript runs. The child carries its hydration annotation. The HTML contains no server-only marker:
only data crosses.

## Browser hydration and interaction

Chromium through Playwright, against the production server. The runner holds every `*.js` request
back and captures the server-rendered nodes first, then releases the scripts:

| Observation                                                                     | Result |
| ------------------------------------------------------------------------------- | ------ |
| Before scripts: `Product 42` and `Count: 0` from SSR                            | ✓      |
| Before scripts: `<add-to-cart>` has `ngh`, not yet hydrated                     | ✓      |
| Child boundary hydrates                                                         | ✓      |
| `article`, `h1`, `button` and the count text node are the same DOM nodes as SSR | ✓      |
| No `[ngh]` left in the document (Angular consumed every annotation)             | ✓      |
| `Count: 0` after hydration; click → `Count: 1`                                  | ✓      |
| Button is still the SSR node after the click                                    | ✓      |
| No console errors, warnings or page errors                                      | ✓      |

Node identity is the evidence that this is hydration and not client re-creation. A re-render would
satisfy the text assertions but not the identity checks. The whole subtree is not re-created either:
the server component's own nodes (`article`, `h1`) are never touched by the browser.

**Dev mode** (manual, `vite` dev server): same result. Angular's dev-mode verifier reported
`Angular hydrated 4 component(s) and 12 node(s), 0 component(s) were skipped` with no mismatch
warnings. The browser loaded `/src/generated/server-components/…/product-details.component.ts`
(the surrogate), `add-to-cart.component.ts` and `islands.ts`, and never loaded
`product-repository.ts` or `server-secret.ts`.

## Decorator finding (separate from the graph result)

The fixture-local `@ServerComponent()` compiles fine with Angular AOT under the stock
`experimentalDecorators` tsconfig. However, the extra, non-Angular class decorator makes TypeScript
emit `tslib`'s `__decorate` (`importHelpers: true`). Nitro traces only `tslib.es6.mjs` into
`dist/analog/server/node_modules/tslib`, while Node resolves `tslib`'s `import` + `node` entry to
`modules/index.js`. The production build succeeds, then SSR of the page fails at runtime with
`ERR_MODULE_NOT_FOUND` and renders an empty `<router-outlet>`. This is the same failure the Analog
baseline records for the SPEC-003 G2 probe
([analog-integration-baseline.md](analog-integration-baseline.md), row G2-prod). The fixture works
around it with `ssr.noExternal: ["tslib"]`. It is a decorator/packaging issue, not a graph one: the
split does not depend on the decorator's runtime. A future build step should strip the decorator at
compile time.

## Bundle size

Measured by the runner (`dist/*` JS files, raw bytes and gzip). "main" is the same measurement on
the baseline `061b0ef` build, before this PoC existed.

| Output               | main (no PoC page) | Plain SSR control | Server component PoC | PoC − control      |
| -------------------- | -----------------: | ----------------: | -------------------: | ------------------ |
| `dist/client` JS     |          264,798 B |         271,343 B |            272,803 B | +1,460 B (+510 gz) |
| `dist/ssr` JS        |          976,524 B |         995,027 B |            995,027 B | 0                  |
| `dist/analog/server` |        4,787,225 B |       4,805,165 B |          4,805,165 B | 0                  |

Client chunks, control → PoC:

| Chunk                          | Control | PoC     | Why                                                                                            |
| ------------------------------ | ------- | ------- | ---------------------------------------------------------------------------------------------- |
| `index-*.js` (shared, Angular) | 268,328 | 270,294 | +1,966 B: `createComponent`, `reflectComponentType` and related code are no longer tree-shaken |
| `server-component.page-*.js`   | 2,601   | 2,095   | −506 B: server component, repository and secret removed; surrogate and island host added       |
| `index.page-*.js`              | 414     | 414     | unchanged                                                                                      |

- **Angular runtime duplicated:** no (one `ng-version` occurrence in both builds).
- **Compiler or runtime added to the browser:** no `@angular/compiler`. About 2 KB of Angular core's
  dynamic-component path, which is a fixed cost paid once per app.
- **Extra client chunks:** none (3 in both builds).
- Server output is identical between control and PoC; the transform only touches `client`. The SSR
  growth over `main` is the new page itself plus `tslib` inlined by the decorator workaround.
- For this tiny component the fixed island cost exceeds the removed implementation. The saving
  scales with the size of the server component and its dependencies; the fixed cost does not.

## Framework surface the PoC depends on

| Surface                                                                                                                        | Kind                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `createComponent({ environmentInjector, elementInjector, hostElement })`, `ComponentRef.setInput`, `ApplicationRef.attachView` | Angular public API                                        |
| `reflectComponentType`, `afterNextRender`, `InjectionToken`, `hostDirectives`, `provideClientHydration()`                      | Angular public API                                        |
| Hydration from a nested host's `ngh` via `createComponent({ hostElement })`                                                    | Angular observed behaviour, **not a documented contract** |
| A component whose template claims none of its server children leaves them in place, without a mismatch                         | Angular observed behaviour, **not a documented contract** |
| Vite `resolveId` / `load` with `this.environment.name`                                                                         | Vite public plugin API (Environment API)                  |
| Analog's environment names `client` / `ssr`                                                                                    | Analog implementation detail                              |
| Analog compiles tsconfig-included files; generated files must exist before its tsconfig read                                   | Analog behaviour (documented tsconfig requirement)        |
| No Angular private (`ɵ`) API is imported by authored code.                                                                     |                                                           |

## Verdict

**CONDITIONAL GO.** Every GO criterion holds:

| Criterion                                                          | Result |
| ------------------------------------------------------------------ | ------ |
| SSR HTML contains server data                                      | ✓      |
| Server component implementation absent from every browser artifact | ✓      |
| Direct server dependency absent                                    | ✓      |
| Transitive server dependency absent                                | ✓      |
| Interactive child present in the browser graph                     | ✓      |
| Interactive child hydrates (node identity, `ngh` consumed)         | ✓      |
| Interaction works after hydration                                  | ✓      |
| No DOM or CSR re-creation hack                                     | ✓      |

The GO is conditional on:

1. **Two unspecified Angular hydration behaviours.** Hydrating a nested component as a root from its
   `ngh` annotation, and a component tolerating server children it never claims, are how Angular
   22.1.7 behaves (read in `retrieveHydrationInfoImpl`, `createComponentRef`, `renderComponent`)
   but not documented guarantees. Either could change in a minor release. They need a pinned
   regression test (this runner) and ideally upstream confirmation.
2. **A non-portable build transform.** It keys on Analog's Vite environment names, writes generated
   Angular source into the app's tsconfig program before Analog compiles, and analyses decorator
   metadata syntactically. The selector must be a string literal and `imports` plain identifiers.
3. **The child is a separate root, hydrated in `afterNextRender`**, not in the same pass as the
   rest of the page. It shares the application and its injectors (`elementInjector` chains to the
   surrogate). It does not share the server component's view.

## Limitations

- **Initial document only.** Client-side navigation to the route would render the surrogate, which
  is empty, because there is no server payload for it. Router navigation, refetch and any
  Flight-like protocol were out of scope and are untested.
- One server component, one client boundary, plain string props. No serialization beyond JSON
  primitives. No content projection from server into client components, and no outputs from client
  to server. Nested boundaries are skipped by the island host but not exercised.
- Every non-runtime `imports` entry of a server component becomes a client reference. A real design
  needs an explicit client mark, so that non-interactive imports stay server-only.
- Props are written twice in the template (`[productId]` and `[strataClient]`); a compiler would
  derive them.
- A server component module may export only the component. The surrogate exports nothing else.
- No dev HMR for the surrogate (it is generated at config time). Dev mode was checked manually, not
  by the runner.
- Early clicks before island hydration are not guaranteed to be replayed (event replay was not
  measured for islands).
- **Build failure over leak (requirement recorded):** the plugin fails the build if the server
  component module itself enters the `client` environment. It does **not** yet detect a server-only
  dependency imported by a _client_ component. That needs a server-only mark on modules and a
  client-graph check, and a future implementation should fail the build rather than ship.
- Node `node-server` preset only; Workers not attempted.

## Reproduce

```bash
pnpm test:server-components
```

The command runs the control build and scan, the PoC build, browser and server scans, bundle sizes,
the production server with a direct HTTP SSR assertion, and Chromium (Playwright) hydration by DOM
identity followed by interaction. It exits non-zero on any failed check. It runs in CI after the
website's Chromium install.
