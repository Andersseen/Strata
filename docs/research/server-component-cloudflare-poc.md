# Server-component PoC on Cloudflare (Pages / workerd)

Evidence report for the third Server Component experiment. Recorded 2026-09-27 on branch
`feat/server-component-cloudflare-poc`, baseline `a455f03` (`main`, merge of PR #24). Written by
hand; `pnpm test:server-components:cloudflare` reproduces every observation below.

**Question.** Does the Strata server component graph split still hold when the Analog application
targets Cloudflare Pages/Workers instead of Nitro's `node-server` preset? That covers the SSR and
the interactive-island hydration. The run uses the same application, the same `@ServerComponent()`
and the same client boundary; only the server runtime is different.

**Verdict: CONDITIONAL GO.**

```text
Analog basic runtime                   GO
@strata-sc/analog controllers          GO
Angular DI experiment (SPEC-003)       NO-GO on workerd (Angular JIT: no code generation from strings)
Server Component direct load           GO
Server Component document navigation   GO
Angular Router navigation              NO-GO, unchanged (recorded in PR #24; reproduced here)
Overall Cloudflare qualification       CONDITIONAL GO
```

Every Server Component GO criterion holds on Wrangler's local Pages runtime. The `cloudflare-pages`
preset is confirmed from Nitro's own metadata. The Worker renders the route with server data, and
the real implementation, its repository and the transitive `server-secret.ts` are in the Worker
graph and absent from the browser graph. The island hydrates onto the SSR nodes, keeping their DOM
identity, and responds to clicks. Document navigation behaves as it does on Node. The condition is
separate from Server Components: the SPEC-003 Angular DI pattern does not run on workerd, so its
Node result of CONDITIONAL GO does not carry over to Workers.

`packages/*` is unchanged and no API was published. The Cloudflare glue is only a build variable and
the Wrangler command line. There is no second server-component model, no Cloudflare-specific file in
the fixture, and nothing was deployed.

## Exact tuple

| Piece                  | Version                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `@angular/*`           | 22.1.7                                                                             |
| `@analogjs/*`          | 2.7.2                                                                              |
| Nitro (`nitropack`)    | 2.13.4, preset `cloudflare-pages` (read from `dist/analog/nitro.json`)             |
| Vite                   | 8.3.0                                                                              |
| Wrangler               | 4.135.0, the copy pinned by `@strata-sc/www` (no second version added)             |
| workerd / Miniflare    | 1.20260918.1 / 5.20260918.0-alpha (as resolved by that Wrangler)                   |
| Compatibility settings | date `2026-09-21` (the website's), **no** compatibility flags (no `nodejs_compat`) |
| Browser                | Playwright 1.62.1, Chromium                                                        |

`nodejs_compat` is deliberately left off. This is the stricter test: the Worker must run without
any Node built-in. With it off, workerd would fail to load any Worker that still imported
`node:*`.

## How the run works

```text
node-server build (default, no BUILD_PRESET)    → preset must read node-server; sizes recorded
BUILD_PRESET=cloudflare-pages vite build        → Analog's documented Cloudflare Pages path
  inspect nitro.json, build log, output tree, Worker entry, reachable Worker module graph
  browser-graph and Worker-graph marker scans; sizes vs Node
wrangler pages dev dist/analog/public           → Analog's documented local preview
  wait for /api/native; HTTP assertions; Chromium flows; Worker log inspection; shutdown
```

`tools/server-components/cloudflare.ts` is the runner. What it reuses from the Node runners:

- `lib/harness.ts`: the check log, the fixture build and the graph scans, which now accept an
  explicit file set.
- `lib/direct-load.ts`: the HTTP SSR and Chromium assertions, moved out of `run.ts` so both
  runtimes run the same code.
- `lib/navigation.ts`: the PR #24 Chromium flows, unchanged.

What is new:

- `lib/wrangler.ts`: resolves Wrangler from `@strata-sc/www` and checks that the binary reports
  the pinned version.
- `lib/module-graph.ts`: the module graph reachable from the Worker entry.

## Build: resolved preset and output

| Evidence                 | Observed                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `dist/analog/nitro.json` | `"preset": "cloudflare-pages"`, Nitro 2.13.4 (the default build reads `"node-server"`)              |
| Build log                | `Generated dist/analog/_routes.json`, `_headers`, `_redirects` (written only by the Pages preset)   |
| `dist/analog/server/`    | absent (the `node-server` output does not exist in this build)                                      |
| Worker entry             | `dist/analog/public/_worker.js/index.js`: `export { R as default } from "./chunks/nitro/nitro.mjs"` |

```text
dist/analog/
  _headers  _redirects  _routes.json  nitro.json
  public/                        ← what `wrangler pages dev` serves
    _worker.js/                  ← the Worker (a directory: Pages "advanced mode")
      index.js                   ← entry, ES module, default export = Nitro fetch handler
      index.mjs                  ← NOT reachable: Nitro prerender entry (see findings)
      chunks/nitro/nitro.mjs     ← Nitro + h3 + Angular (incl. @angular/compiler) + unenv
      chunks/virtual/_virtual_ANALOG_SSR_RENDERER.mjs
      chunks/_/server-component.page-*.mjs   ← the real server component
      chunks/_/{index,server-component-navigation}.page-*.mjs, xhr2*.mjs
      chunks/routes/api/{native,seam,strata-core,strata-angular-di-stats}.mjs
    assets/*.js  index.html      ← browser assets (identical to the Node build's)
dist/client/                     ← Vite client build (browser graph)
dist/ssr/                        ← Vite SSR build (input to Nitro)
```

The reachable Worker graph has 12 modules. It is computed by following static, `export … from` and
dynamic imports from `index.js`. The run relies on this graph, not on a directory listing, because
the directory also holds a file that is never executed.

## Worker compatibility (Node APIs)

| Check                                                               | Result                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports leaving the reachable graph                                 | none                                                                                                                                                                                                                                                       |
| `node:*` / Node built-in imports (`fs`, `path`, `child_process`, …) | none                                                                                                                                                                                                                                                       |
| Scanner control                                                     | The unreachable `index.mjs` is flagged by the same scan (`node:process`, `node:fs`, `node:url`), so the scan does detect Node imports                                                                                                                      |
| Node remnants inside the graph                                      | Nitro's `unenv` substitutes: 13 "not implemented" shims (`http.createServer/request/get/…`, `process.report.*`, `process.finalization.*`, `process.permission.has`) and 150 `Buffer` identifiers resolved inside the bundle. `process.env` 0, `require(` 0 |
| `new Function` in the graph                                         | 2 occurrences, both in bundled Angular code. The JIT evaluator is the one exercised below                                                                                                                                                                  |
| Worker boots without `nodejs_compat`                                | yes                                                                                                                                                                                                                                                        |
| Worker errors during the whole run                                  | only the characterized Angular DI request                                                                                                                                                                                                                  |

The `http.*` shims come from `@angular/platform-server`'s `xhr2` polyfill, which is bundled but
never invoked by these routes. A server component that made outbound HTTP through Angular's
Node-flavoured XHR would reach a shim that throws, so this is a caution for later work and not a
finding against this PoC.

## Native Analog route and `@strata-sc/analog`

| Request                                             | Result                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/native` (Analog file-system route)        | 200 `{"source":"analog"}`: **GO**                                         |
| `GET /api/strata/users`                             | 200 `[{"id":"1","name":"Ada"}]`                                           |
| `GET /api/strata/users/42` (dynamic route)          | 200 `{"id":"42","name":"Ada"}`                                            |
| `GET /api/strata/greeting` ×2 (`controllerFactory`) | 200 `{"greeting":"hello","calls":1}` both times: one instance per request |

`registerControllers(nitroApp.router, …)` from a Nitro plugin works unchanged inside the Worker.
**`@strata-sc/analog` controllers: GO.**

## Angular DI experiment (SPEC-003): NO-GO on workerd

`GET /api/strata/angular-di/products/a` → **500**. The Worker log shows:

```text
EvalError: Code generation from strings disallowed for this context
  newTrustedFunctionForJIT ← JitEvaluator.evaluateCode ← JitEvaluator.evaluateStatements
  ← CompilerFacadeImpl.jitExpression ← CompilerFacadeImpl.compileFactory
  ← RequestIdentity.ɵfac (getter) ← getFactoryDef ← providerToFactory
```

What was measured:

- The Worker starts. The side-effect import of `@angular/compiler` loads, and the consumer-owned
  application injector resolves: `createApplication()` on `platformServer()`, whose result the
  factory awaits before failing.
- The failure comes at `createEnvironmentInjector(...)` for the request. That call needs the
  factory of the fixture's `@Injectable()` `RequestIdentity`. Nitro bundles `src/server/**`
  without Angular's compiler, so that factory is JIT-compiled on first use. Angular's JIT emits
  code through `new Function`, and workerd refuses code generation from strings.
- The failure is contained. No request injector is created (`injectorsCreated` 0, `injectorsAlive`
  0), so `onCleanup` has nothing to release. The Worker keeps serving every other route.
- **Classification: Angular JIT restriction**, which is also an unsupported-dynamic-eval case. It
  is not a Node API dependency, a Nitro preset mismatch or a module-format problem, and it is not
  caused by Strata. The run applied no workaround: no `eval` shim, no unsafe-eval flag, no code
  injection.

The Node result, a CONDITIONAL GO from SPEC-003, is unchanged. **On Workers this experiment is NO-GO
as built.** `controllerFactory` and `onCleanup` themselves work on workerd, since the `greeting`
controller above uses the factory. What fails is the JIT-dependent way the fixture's Angular
services are compiled. The runner pins this failure: if the route ever succeeds, the check fails so
that this section gets revisited.

## `@angular/compiler`

| Question                 | Answer                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In the Worker graph?     | yes, bundled into `chunks/nitro/nitro.mjs` (`nitro.moduleSideEffects: ['@angular/compiler']` still keeps it)                                                      |
| In the browser graph?    | no                                                                                                                                                                |
| Worker startup succeeds? | yes: importing it does not evaluate code                                                                                                                          |
| Does its purpose work?   | no. Its only job here is JIT, and workerd forbids JIT's code generation (see the DI experiment)                                                                   |
| Approximate cost         | standalone, the package minifies to about 621 KB (about 163 KB gzip), roughly a quarter of the 2.35 MB Worker; its exact share inside `nitro.mjs` is not isolated |

It was not removed. It is still required on Node for SPEC-003, and removing it would not make the DI
route work on workerd.

## Server Component direct load: GO

With Wrangler serving `GET /server-component`:

- The response is **200 `text/html`** and, before any JS runs, contains `<h1>Product 42</h1>`,
  `<p>Server rendered product</p>` and `Count: 0`.
- The SSR HTML carries `<product-details ngh="0">` and `<add-to-cart data-strata-client="add-to-cart"
data-strata-props="{…productId…42}" ngh="0">`, which is the data hydration needs. The rendered
  subtree is byte-identical to the Node run's.
- None of the three server-only markers is in the HTML; only data crosses.

In Chromium against Wrangler, with application JS held back until the SSR DOM had been captured:

| Check                                                                    | Result |
| ------------------------------------------------------------------------ | ------ |
| before JS: Product 42 visible, `Count: 0`, child has `ngh`, not hydrated | ✓      |
| child boundary hydrates                                                  | ✓      |
| same `article`, `h1`, `button` and count text node after hydration       | ✓      |
| every `ngh` consumed                                                     | ✓      |
| `StrataIslandHost` created exactly 1 island; 1 boundary marked hydrated  | ✓      |
| click Add to cart → `Count: 1`; button is still the SSR node             | ✓      |
| no console error, warning or page error                                  | ✓      |
| loaded scripts: no server-only marker; client component present          | ✓      |

The UI is hydrated, not deleted and recreated. The same identity assertions as PR #23 pass, and a
new "exactly one island" assertion now runs on both runtimes.

## Graph results

| Marker                                                      | Worker graph (reachable)        | Browser graph (`dist/client` + `dist/analog/public` minus `_worker.js/`) |
| ----------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `STRATA_SERVER_COMPONENT_IMPLEMENTATION_MARKER`             | ✓ `server-component.page-*.mjs` | ✗                                                                        |
| `STRATA_SERVER_COMPONENT_REPOSITORY_MARKER`                 | ✓                               | ✗                                                                        |
| `STRATA_TRANSITIVE_SERVER_ONLY_MARKER` (`server-secret.ts`) | ✓                               | ✗                                                                        |
| `STRATA_CLIENT_COMPONENT_MARKER`                            | ✓ (SSR renders it)              | ✓ `assets/server-component.page-*.js`                                    |
| `STRATA_ANALOG_CLIENT_CONTROL_MARKER`                       | n/a                             | ✓                                                                        |
| `@angular/compiler`                                         | ✓                               | ✗                                                                        |

No browser file is named after a server-only module. On this preset the Worker sits inside the
directory Pages serves, so the browser scan excludes `_worker.js/`. That exclusion was then checked
over HTTP: `GET /_worker.js/index.js` and `GET /_worker.js/chunks/_/server-component.page-*.mjs`
return HTML rendered by the app, never the files. Pages does not serve the Worker. The transitive
negative-control chain `ProductRepository → server-secret.ts` is kept and holds: Worker ✓,
browser ✗.

## Document navigation: GO

For `/server-component-navigation` → plain `<a href>` → `/server-component` under Wrangler:

- A new document request reached the Worker, and the page runs in a new JS realm (the sentinel is
  gone).
- The document HTML carries the server data and no server-only marker.
- The island hydrates, with 1 island and no `ngh` left, and the count goes 0 → 1.
- Re-entry creates a new realm and one island, and each click adds one: `Count: 1`, then
  `Count: 2`, so there is no duplicate handler.
- There were no console errors.

## Angular Router navigation: NO-GO unchanged

For `routerLink="/server-component"` under Wrangler: the same JS realm, no document request and no
server payload. The host renders as the empty surrogate, with no article, no Product 42 and no
island. The runtime change does not alter the semantics recorded in PR #24. No fix was attempted,
and the contract stays **direct document request + document navigation**.

## Bundle size: Node vs Cloudflare

| Output                                    | Runtime    | JS files |  JS bytes |   JS gzip |
| ----------------------------------------- | ---------- | -------: | --------: | --------: |
| browser                                   | Node       |        8 |   572,208 |   174,862 |
| browser                                   | Cloudflare |        8 |   572,208 |   174,862 |
| server, own chunks (`dist/analog/server`) | Node       |       11 | 1,294,060 |   269,227 |
| server incl. traced `node_modules`        | Node       |      265 | 4,834,288 | 1,059,120 |
| Worker, reachable graph                   | Cloudflare |       12 | 2,347,325 |   639,890 |

The browser output is the same size on both presets. The Worker bundles everything that Node
leaves in traced `node_modules`: Angular, h3, the compiler and the `unenv` shims. It comes to
2.35 MB, about 640 KB gzip, in 12 modules. There is no sign of a size explosion. No budget is set
yet.

## Other findings (recorded, not fixed)

1. **A stale prerender entry ships with the Worker.** Analog prerenders `/` with Nitro's prerender
   build, which leaves `_worker.js/index.mjs` (plus its map) in the Worker directory. That file is
   a Node module (`node:fs`, `node:url`, `node:process`) with absolute `file:///…` imports of the
   build machine's paths. Nothing imports it, but Wrangler attaches it as an additional module
   ("Attaching additional modules"), so a real `pages deploy` would upload it. It has no runtime
   effect, but it is untidy and leaks local paths.
2. **The Pages routing files land outside the served directory.** Nitro writes `_routes.json`,
   `_headers` and `_redirects` to `dist/analog/`, and `_routes.json` lists `/public/…` paths. The
   documented preview serves `dist/analog/public`, so these files are not applied, and every
   request, assets included, first reaches the Worker, which falls back to the `ASSETS` binding.
   Correctness is unaffected. Cost and latency of static assets on a real deploy are a later
   concern.
3. **Angular's Node XHR polyfill is bundled.** `xhr2` is in the Worker behind `unenv` `http.*`
   shims that throw. It is harmless for these routes.

## Classification

| Capability                           | Result                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Analog basic runtime                 | **GO**                                                                          |
| `@strata-sc/analog` controllers      | **GO**                                                                          |
| Angular DI experiment                | **NO-GO** on workerd: Angular JIT restriction (Node: CONDITIONAL GO, unchanged) |
| Server Component direct load         | **GO**                                                                          |
| Server Component document navigation | **GO**                                                                          |
| **Overall Cloudflare qualification** | **CONDITIONAL GO**                                                              |

The overall result is conditional on three points:

- The SPEC-003 Angular DI pattern is not portable to Workers as built. It depends on JIT-compiled
  `@Injectable()` factories, and there `@angular/compiler` is about a quarter of the Worker with
  nothing it can do.
- Server-component routes keep the document-navigation-only contract from PR #24.
- The evidence comes from Wrangler's local workerd, not a deployed Pages project.

Every Server Component GO criterion holds:

```text
cloudflare-pages preset confirmed ✓   Wrangler runtime boots ✓   SSR server data ✓
server implementation browser ✗       repository browser ✗       transitive dependency browser ✗
server code in Worker graph ✓         interactive child browser ✓ hydration ✓
SSR DOM identity ✓                    interaction ✓               document navigation ✓
native Analog unaffected ✓
```

## Limitations

- The runtime is local workerd through `wrangler pages dev`. Cloudflare's production edge was not
  exercised, and nothing was deployed.
- One compatibility date, and no compatibility flags.
- One page and one island. Streaming, bindings and outbound fetches were not exercised.
- The Worker graph is found by a lexical scan of bundler output, as documented in
  `lib/module-graph.ts`, not by a full parser. The scanner control above shows it detects Node
  imports.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm --filter @strata-sc/www exec playwright install chromium   # once
pnpm test:server-components:cloudflare
```

No Cloudflare account, token or secret is needed. The command runs in CI after
`pnpm test:server-component-navigation`.
