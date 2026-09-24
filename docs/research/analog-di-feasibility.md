# Analog request lifecycle and Angular DI feasibility

Evidence report for [SPEC-003](../specs/003-analog-request-lifecycle-angular-di.md). Recorded
2026-09-24 on branch `feat/spec-003-analog-di-feasibility`, baseline `c671ba4` (`main`, merge of
PR #19). Written by hand, unlike the [Analog integration baseline](analog-integration-baseline.md),
which `pnpm test:analog` regenerates and which holds the executed tables this report cites.

**Question.** Can a Strata controller running inside an Analog/Nitro application get request-scoped
Angular services, without retaining request state between users and without an architecture that
conflicts with Analog?

**Verdict: CONDITIONAL GO.** Yes, through Angular's public DI APIs and Strata's existing
`controllerFactory` + `onCleanup` seam, with an application injector the consumer owns. It is **not**
Analog's injector: no supported seam exposes the injector of an SSR render or of Analog's server
functions, and in the production build the SSR renderer runs a different copy of Angular anyway.
The conditions are listed under [Verdict](#verdict).

## Exact tuple

Read from the installed packages; the same tuple the integration baseline records.

| Package                                   | Version       | Role                                                   |
| ----------------------------------------- | ------------- | ------------------------------------------------------ |
| Node                                      | 22.23.0       | Runtime (dev and `node-server` production)             |
| `@angular/core`                           | 22.1.7        | DI: `createApplication`, `createEnvironmentInjector`   |
| `@angular/platform-server`                | 22.1.7        | `platformServer`, `provideServerRendering`, SSR render |
| `@angular/platform-browser`               | 22.1.7        | `createApplication`                                    |
| `@angular/compiler`                       | 22.1.7        | JIT fallback inside the Nitro bundle (see below)       |
| `@analogjs/platform`, `vite-plugin-nitro` | 2.7.2         | Analog build, generated Nitro renderer/handlers        |
| `@analogjs/router`                        | 2.7.2         | `render()`, server functions, `REQUEST` tokens         |
| `nitropack`                               | 2.13.4        | Nitro 2 runtime, plugins, `nitroApp.router`            |
| `h3`                                      | 1.15.11       | Nitro's HTTP layer (H3 v1)                             |
| TypeScript / Vite                         | 6.0.3 / 8.3.0 |                                                        |

No Cloudflare/Workers build or execution was performed.

## Lifecycle trace

Paths are relative to each package's installed root; line numbers are from the versions above.

### Nitro request → Strata controller

1. Nitro routes the request through its H3 v1 app to `nitroApp.router`, where `@strata/analog`
   registered the controller's handler from a Nitro plugin (`registerControllers`). Nitro's own
   `request`/`afterResponse` hooks exist (`nitropack/dist/runtime/internal/app.mjs:77`, `:87`) but
   are app-wide, not per route; Strata does not use them.
2. `@strata/analog` builds a `StrataAnalogRequest`, awaits
   `controllerFactory(Controller, { request, onCleanup })`, calls the handler with that instance as
   `this`, then runs the registered cleanups (LIFO, awaited) before its route handler settles (`packages/analog/src/register-controllers.ts`,
   `cleanup-scope.ts`; PRs #18 and #19).
3. **No Angular injection context exists on this path.** Nitro server routes (`src/server/routes/**`)
   and Strata controllers are plain Nitro handlers; Analog does not wrap them.

### SSR render

1. Analog's generated renderer (`@analogjs/vite-plugin-nitro/src/lib/utils/renderers.js:1-20`,
   `ssrRenderer`) calls the app's `main.server.ts` default export with `{ req, res }` and returns
   HTML.
2. `render()` (`@analogjs/router/fesm2022/analogjs-router-server.mjs:432`) calls Angular's
   `renderApplication()` with `provideServerContext({ req, res })` (`:309`) as **platform**
   providers: `REQUEST`, `RESPONSE`, `BASE_URL`, `LOCALE` and an in-process server-function
   dispatcher.
3. `renderApplication()` (`@angular/platform-server/fesm2022/platform-server.mjs:171`) creates a new
   platform per render (`createServerPlatform`, `:31`), bootstraps the application (a new root
   `EnvironmentInjector` per render), renders, and destroys the platform in `finally` on a macrotask
   (`asyncDestroyPlatform`, `:132`).
4. **Request injector:** yes — the per-render application injector. **Reachable from outside?** No.
   It exists only inside `renderApplication()`; `render()` returns a string. No Nitro hook, Analog
   option or exported function hands it out. Its lifetime is one render, which is a different HTTP
   request from any controller call.

### Server functions (Analog 2.7.2)

1. When `*.server.ts` modules exist, Analog generates a `/_analog/fn/:id` Nitro handler
   (`vite-plugin-nitro/src/lib/utils/server-fn-endpoints.js:35`, `buildServerFnDispatchModule`). It
   imports `app.config.server.ts` and bootstraps **one process-level injector**:
   `createServerFnAppInjector(config)` (`:70`) →
   `createApplication(config, { platformRef: platformServer() })` with no root component
   (`analogjs-router-server.mjs:902`). The injector is a module-local value of that generated
   virtual module; nothing exports it.
2. Per call, `dispatchServerFn()` (`:170`) creates a child `Injector.create({ parent, providers })`
   with `REQUEST`, `RESPONSE`, `BASE_URL` and `LOCALE` (`:225`) and re-enters `runInInjectionContext` around
   each interceptor and the handler (`:238`), so `inject()` works after an interceptor `await`s.
   The per-call injector is **never destroyed** (no `destroy()` in `:170-295`).
3. During SSR, in-process server-function calls use the **render's** injector as parent
   (`createServerFnDispatcher`, `:296`). Over HTTP they use the process-level injector. Both are
   built from the same `app.config.server.ts`, but they are different injectors with different
   `providedIn: 'root'` instances.
4. The generated module starts with `import '@angular/compiler'`. Its comment explains why: it is
   bundled by Nitro, not by the Angular pipeline, so the Angular linker never processes it and
   partially compiled Angular packages need the JIT compiler. Analog declares that import in
   `nitro.moduleSideEffects` (`vite-plugin-nitro.js:130`), but **only when the app has server
   functions**.

### Angular platform and injection-context semantics

- `getPlatform()` returns `null` when `ngServerMode` is set (`@angular/core/fesm2022/core.mjs:2370`);
  on the server `createPlatformFactory` returns a fresh platform on every call and `createPlatform`
  does not store it globally (`:2319-2346`). A long-lived platform therefore does not collide with the
  per-render SSR platforms. `provideServerRendering()` sets `ngServerMode`
  (`platform-server.mjs:16-19`).
- `internalCreateApplication` requires an explicit `platformRef` on the server (`core.mjs:2411`).
- `runInInjectionContext` sets the current injector, runs `fn` synchronously and restores the
  previous injector in `finally` (`_pending_tasks-chunk.mjs:1445`); `inject()` outside it throws
  `NG0203` (`assertInInjectionContext`, `:1473`). Nothing survives an `await`.

### Answers

| Question                                                  | Finding                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where are EnvironmentInjectors created?                   | Per SSR render (`renderApplication`); once per process for HTTP server functions (`createServerFnAppInjector`).                                                    |
| Is there a request-specific injector?                     | SSR: the whole per-render app. Server functions: a child `Injector` per call.                                                                                      |
| Publicly accessible through a supported hook?             | **No**, for either.                                                                                                                                                |
| When destroyed?                                           | SSR: after the render (platform destroy). Server-function call injector: never explicitly; process injector: never.                                                |
| Do server routes/controllers run in an injection context? | **No.**                                                                                                                                                            |
| Do server functions share the SSR mechanism?              | No: a separate process-level app injector over HTTP; the render's injector only for in-process calls during SSR.                                                   |
| Supported integration point for arbitrary handlers?       | None found. The public building blocks are Angular's (`createApplication`, `createEnvironmentInjector`, `runInInjectionContext`) and Strata's `controllerFactory`. |
| Would reuse need private/internal APIs?                   | Yes: patching Analog's generated virtual modules or renderer. Not attempted.                                                                                       |

## Candidates

### A — reuse Analog's request injector: not available

There is nothing supported to reuse. The SSR injector lives only inside a render, and the
server-function injector is private to a generated module. Reaching either would mean patching
Analog's generated code: a private dependency this step refuses to take.

Sharing would be limited even with a seam, for two reasons. First, a controller request and an SSR
render are different HTTP requests, so "same request" identity only exists for in-process calls
during a render (the way Analog's own server functions are called during SSR). Second, in the
production build the SSR renderer chunk (`dist/analog/server/chunks/virtual/_virtual_ANALOG_SSR_RENDERER.mjs`)
inlines its own AOT-linked copy of Angular, while Nitro plugin code imports the traced
`node_modules/@angular/*`. **One production process contains two Angular runtimes**, so tokens and
classes would not even be the same objects. Reuse needs an upstream Analog seam and a single
Angular runtime copy, not a Strata workaround.

### B — Strata-owned Angular injector: rejected as a package responsibility

Letting `@strata/analog` create the Angular injectors would put `@angular/*` into the adapter's
dependencies and decide the application configuration on the user's behalf. It would still be a
**second DI universe**, whoever created it. The fixture measured what that means (see
[Limitations](#limitations)): separate `providedIn: 'root'` instances from SSR and from server
functions, separate `APP_INITIALIZER` runs, no Analog `REQUEST`/`RESPONSE` tokens, no shared caches.
Owning that inside Strata would hide the duplication instead of making it explicit.

### C — explicit host bridge: selected

The consumer's Nitro plugin owns the Angular injectors. Strata owns _when_: it calls the factory once
per request and runs `onCleanup` callbacks when the invocation settles. The bridge already exists and
is public (`controllerFactory`, `StrataAnalogControllerFactoryContext.onCleanup`, PRs #18/#19). This
step needed no new Strata API. The fixture's consumer-owned glue uses the injector shape Analog uses
for its server functions:

```text
Nitro plugin (startup)
  createApplication({ providers }, { platformRef: platformServer() })   → application injector (process)
request
  @strata/analog → controllerFactory(Controller, { request, onCleanup })
    createEnvironmentInjector([STRATA_REQUEST, request-scoped providers], appInjector)
    onCleanup(() => requestInjector.destroy())
    runInInjectionContext(requestInjector, () => new Controller())   ← field inject() runs here
  handler(request)                                                     ← no injection context
  cleanups (LIFO) → requestInjector.destroy() → ngOnDestroy / DestroyRef
response
```

Why C over B: ownership stays with the application, which is the only party that knows its
providers. `@strata/analog` keeps zero Angular dependencies. The duplication is visible in the
application's own code, not hidden behind a Strata default.

## Implemented experiment

Files, all consumer-owned under `apps/analog-fixture`:

- `src/server/plugins/strata-angular-di.ts`: bootstraps the application injector, destroys the
  application and platform on Nitro `close`, registers `CatalogController` with the factory.
- `src/server/strata/angular-di/angular-controller-factory.ts`: the per-request bridge above.
- `src/server/strata/angular-di/providers.ts`: `CatalogService`
  (`@Injectable({ providedIn: 'root' })`, the stand-in for a future ForgeCMS runtime),
  `RequestIdentity` (`@Injectable()`, request-scoped, `ngOnDestroy`), `RequestAudit`
  (request-scoped, injects `RequestIdentity`) and `STRATA_REQUEST`.
- `src/server/strata/angular-di/angular-di.controller.ts` and `rendezvous.ts`: the controller and a
  test barrier.
- `vite.config.ts` / `vite.probe.config.ts`: `nitro.moduleSideEffects: ["@angular/compiler"]`.

The developer experience, as implemented:

```ts
@Controller("/api/strata/angular-di")
export class CatalogController {
  private readonly catalog = inject(CatalogService); // application lifetime
  private readonly identity = inject(RequestIdentity); // request lifetime

  @Get("/products/:id")
  async findOne(request: StrataAnalogRequest) {
    await somethingAsync();
    return this.catalog.findProduct(request.params["id"] ?? ""); // captured, not re-injected
  }
}
```

`StrataAnalogRequest` stays the explicit HTTP input. The factory also provides it as
`STRATA_REQUEST` so request-scoped services can read it during construction. `request.context` is
not used as a container, and controller-side files import no `h3`/`nitropack` module or event type
(checked by `test:analog`).

### Two findings that shaped the experiment

1. **Nitro-bundled Angular needs the JIT compiler.** First attempt, without it: importing
   `@angular/platform-server` into a Nitro plugin failed while the module loaded:
   "The injectable 'PlatformLocation' needs to be compiled using the JIT compiler…". Because
   plugins load at startup, **every route in the server answered 500, native Analog routes
   included**. Adding `import "@angular/compiler"` alone did not help: Nitro tree-shook the bare
   import (verified in `dist/.nitro/dev/index.mjs`). It works only once `@angular/compiler` is
   declared in `nitro.moduleSideEffects`, which is what Analog does for its own server functions.
2. **`@angular/platform-server/init` is not needed** for DI and installs domino DOM globals
   process-wide, so the plugin does not import it. `provideServerRendering()` is constructed before
   `platformServer()` so `ngServerMode` is set first.

## Results

`pnpm test:analog`, dev server and production server (`node dist/analog/server/index.mjs`). The full
per-scenario table (responses and counter deltas) is in the
[integration baseline](analog-integration-baseline.md#experiment-spec-003-angular-di-through-controllerfactory).
Every scenario passed in both modes.

| Scenario                                      | Evidence (both modes)                                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two requests held at a rendezvous             | Both `met: true`; different `identity` (e.g. 1 and 2), each with `identityProductId` equal to its own product id; same `catalogInstance: 1`; `maxInjectorsAlive: 2`; delta: 2 created, 2 destroyed, 2 `ngOnDestroy`, 2 controller `DestroyRef` callbacks. |
| One request alone at the rendezvous (control) | `met: false` after 5 s. Every other assertion still holds, so the barrier can tell overlapping requests from a lone one.                                                                                                                                  |
| Same-request identity                         | `auditSharesIdentity: true`: the controller and `RequestAudit` resolved the same `RequestIdentity` instance.                                                                                                                                              |
| Request input                                 | `injectedRequestIsArgument: true`: `inject(STRATA_REQUEST)` is the handler's `StrataAnalogRequest`; `request.params["id"]` drives the product.                                                                                                            |
| `inject()` inside a handler                   | `NG0203` before the first `await` and after it. The handler never runs in an injection context: Strata calls it after `await controllerFactory(...)` returns.                                                                                             |
| Captured dependency after `await`             | Works: `this.catalog`/`this.identity` resolved in field initializers are used after the rendezvous `await`. `destroyedBeforeResponse: false`.                                                                                                             |
| Handler throws synchronously                  | 500; delta 1/1/1/1 (created, destroyed, `ngOnDestroy`, `DestroyRef`).                                                                                                                                                                                     |
| Async handler rejects after an `await`        | 500; delta 1/1/1/1.                                                                                                                                                                                                                                       |
| Application lifetime                          | `catalogInstances` stays at 1 across every request of the process (created lazily by the first request).                                                                                                                                                  |
| Native Analog behaviour                       | `/api/native`, SSR of `/`, and every pre-existing Strata route still pass their checks in both modes.                                                                                                                                                     |

Concurrency is enforced, not assumed. `?meet=<key>` holds each handler at a barrier that releases
only when two requests with the same key are both suspended in their handlers. Sequential requests
cannot release it; the lone-request control shows that. Counters are read before and after each
scenario, once each, with no retry, after every response has arrived.

## Bundle evidence

From the same production build (marker scan in the integration baseline):

| Output               | `STRATA_ANALOG_ANGULAR_DI_MARKER`  | Other server-only Strata markers | `@angular/compiler`        |
| -------------------- | ---------------------------------- | -------------------------------- | -------------------------- |
| `dist/analog/server` | present (`chunks/nitro/nitro.mjs`) | present                          | traced into `node_modules` |
| `dist/ssr`           | absent                             | absent                           | absent                     |
| `dist/client`        | absent                             | absent                           | absent                     |
| `dist/analog/public` | absent                             | absent                           | absent                     |

Cost, measured once by building with and without the DI plugin (same tree otherwise): server output
**4,492 KB → 7,716 KB**. Without the plugin only `@angular/core` is traced into
`dist/analog/server/node_modules`; with it, `common`, `compiler` (`compiler.mjs` ≈ 2.1 MB),
`platform-browser` and `platform-server` are traced too. Browser output is unchanged (268 KB in
both `dist/client` and `dist/analog/public`). These are unminified server files, not a cold-start or
memory measurement.

## Lifetimes

| Lifetime              | Owner                                                                    | Holds                                                      | Ends                                                               |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Application / process | Consumer's Nitro plugin (`createApplication` on `platformServer()`)      | `providedIn: 'root'` and application providers             | Nitro `close` hook: `appRef.destroy()`, `platformRef.destroy()`    |
| Request               | Consumer's factory creates it; Strata decides when it ends (`onCleanup`) | Providers listed on the request injector, `STRATA_REQUEST` | After the handler settles, success or failure, before the response |
| Controller            | `@strata/analog` (one per request, since PR #18)                         | Fields resolved at construction                            | With its request injector (`DestroyRef`)                           |

Controllers stay request-scoped and are not configurable. Only providers listed on the request
injector are request-scoped. A `providedIn: 'root'` service is process-wide here: request data must
never be stored in one.

## Limitations

- **No identity sharing with Analog.** The application injector is separate from every SSR render's
  injector and from Analog's server-function injector. Root services are separate instances, and
  application initializers run once more. A process-wide singleton shared by all three needs state
  outside Angular DI, or an upstream Analog seam. In production, SSR also runs a different Angular
  copy.
- **Configuration is not shared automatically.** The fixture passes its own provider list. Passing
  `app.config.server.ts`, as Analog does for server functions, was not tried: it would pull
  `provideFileRouter()` and the page graph into the Nitro bundle.
- **JIT compiler in the server graph.** This requires `@angular/compiler` in
  `nitro.moduleSideEffects` and costs about 3.2 MB of traced server files. Consumer `@Injectable()`
  classes in `src/server/**` are JIT-compiled at runtime. Without the setting, the whole server fails
  at startup.
- **`inject()` is construction-time only.** Resolve in field initializers or the constructor; a
  handler body, before or after `await`, has no injection context.
- **Cleanup scope is the controller invocation.** Client abort and timeouts were not exercised:
  Strata has no abort signal, so a handler keeps running until it settles, and then cleanup runs.
  A streamed response body can outlive the request injector.
- **Not exercised:** provider overrides in tests; an application-scoped service trying to inject a
  request-scoped token (Angular resolves upward from the providing injector, but no test here
  proves the failure mode); Cloudflare/Workers; more than two concurrent requests; load.
- **Provisional.** The glue is fixture code, not a supported Strata API. No Changeset and no ADR.

## Verdict

**CONDITIONAL GO** for building the first strict Server Component feasibility PoC on this lifecycle,
under these conditions:

1. The PoC treats the Strata application injector as its own DI universe and does not assume that
   SSR or server functions share its service instances.
2. Request-scoped services are listed explicitly on the request injector; `inject()` runs only
   during construction.
3. The consumer configuration (`nitro.moduleSideEffects: ["@angular/compiler"]`) is recorded as a
   prerequisite, and the compiler's server-only placement stays asserted.
4. Workers execution, abort/timeout cleanup and upstream seam requests (a public Analog hook for the
   server-function or render injector, and a single Angular runtime copy in production) remain
   open follow-ups (R03, R04, R12, R13), not assumptions.

Package boundary: no `@strata/angular`. The only Angular-specific code is about 40 lines of consumer
glue with no reusable runtime responsibility apart from Analog yet. Revisit this when Server
Components need a shared helper. `@strata/core` and `@strata/h3` are unchanged.
