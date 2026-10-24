# @strata-sc/analog

## 0.9.0

### Minor Changes

- ebb969b: Add `request.validateHeaders(schema)`: opt-in Standard Schema v1 validation of a frozen, lowercase, string-valued header snapshot, with inferred output types. Invalid input answers the existing safe 400 with `source: "headers"`, follows cleanup-first precedence and is observed as `input-rejected`. Exports the `StrataAnalogHeaders` type.

## 0.8.0

### Minor Changes

- 15080f5: Add `onRequestSettled`, an opt-in observer of each Strata controller invocation, so an application can log, count or export how a request ended without Strata becoming a logging or telemetry system. It is a `registerControllers()` option and changes nothing when absent.

  The observer is called exactly once per invocation with a frozen, structured `StrataAnalogRequestObservation`: the registered route (method, route template, controller and handler names, never the request URL), a finite `outcome` (`completed`, `guard-denied`, `input-rejected`, `application-error`, `failed`, `cleanup-failed`, `stream-completed`, `stream-failed`, `stream-cancelled`), the `phase` it ended in, whether it was `streaming`, whether `cleanup` completed, a `status` only where Strata itself produced it (guard denial, rejected input, `StrataAnalogHttpError`; otherwise `undefined`, never a guessed 500), and two monotonic durations: `invocationMs` (guards, interceptors and handler, before cleanup; for a stream, until the stream was returned) and `elapsedMs` (until the observation, after cleanup; for a stream, the full observed body lifetime). It never carries request values, headers, bodies, error messages, causes, stacks, validation issues or response content.

  It is emitted after the invocation's cleanups have settled, and a cleanup failure is `cleanup-failed`, never a success. For an owned `streamResponse()` it is emitted when the body completes, fails or is cancelled and its cleanups have settled, not when the handler returns; an interceptor that replaces the stream produces an ordinary `completed` observation, and a stream the transport never reads or cancels is never reported (Strata does not observe client disconnects and will not invent a timeout). A derived `HEAD` over a stream is reported as `stream-cancelled`.

  The callback is synchronous and isolated: its return value is ignored and never awaited, and anything it throws or rejects with is discarded, so it cannot change the response, the original error or a cleanup `AggregateError`. Native Nitro routes, the API boundary's own 404/405 answers and Analog server functions are not observed. Qualified with `pnpm test:analog-observability` on Nitro Node, the Vite dev server and local workerd (not a deployed Pages project), and from an externally installed packed tarball.

## 0.7.0

### Minor Changes

- 49fabe7: Add `streamResponse()`, an explicit, opt-in way to keep a request's cleanup scope open for the life of a streamed response body. Until now cleanup ran when the handler settled, so an ordinary `Response` over a `ReadableStream` found its request-scoped resources (an Angular request injector, a database cursor) already closed when the transport began reading it; that behavior is unchanged for every handler that does not use the helper. `streamResponse(body, init?)` wraps an async iterable of strings or bytes in a native `Response` that is pulled lazily, one chunk per read. After the handler and every interceptor have settled, the adapter binds the invocation's cleanup scope to that response, and the scope closes exactly once, last registered first and awaited, on the first of completion, a failing body, or cancellation of the body. A failing body or cleanup errors the stream (the body error first, then every cleanup error, in an `AggregateError` when both fail) and Strata writes no message or stack into the response. A response an interceptor replaces is not owned and closes eagerly; reading an owned body before the adapter owns it, or returning one response from two invocations, fails with a `StrataAnalogConfigurationError`. Guards, validation, a derived `HEAD` and the existing cleanup, error-precedence and interceptor rules are unchanged.

  Qualified on the pinned Analog 2.7.2 / Nitro 2.13.4 / H3 1.15.11 tuple: Node (production and dev) delivers the body incrementally; the local Cloudflare Pages runtime buffers it, still delivering the complete body and releasing the resources once. Client-disconnect cancellation is not propagated to the body on either runtime, so a streamed body must be finite, and what a client observes after a body fails mid-stream is decided by the transport. No new peer dependency and no change to `@strata-sc/core`.

## 0.6.0

### Minor Changes

- dafb5fa: Add an opt-in HTTP routing and API boundary contract. `registerControllers()` accepts `apiBoundary: { prefixes, nativeRoutes?, head?, options? }` to explicitly own API path prefixes: unknown paths below them answer a safe JSON `404` instead of Analog's HTML shell, known paths with an unsupported method answer `405` with an accurate `Allow`, `HEAD` is derived from the matching `GET` route (one pipeline run, no body), and plain `OPTIONS` can be answered without ever answering or enabling CORS. Native Nitro routes, Analog pages and server functions are never shadowed, framework 404/405 answers run no guard, interceptor or controller factory, and registration validates prefixes, native declarations and route patterns before touching the router. Without the option, behavior is unchanged.

## 0.5.0

### Minor Changes

- d1abf71: Add safe typed application HTTP errors and portable JSON and no-content response helpers to Analog controllers. Expected application failures now produce deterministic redacted responses after request cleanup succeeds.

## 0.4.0

### Minor Changes

- b5b3157: Add opt-in request-scoped guards that run before controller construction.
- 5b9fabc: Add opt-in request-scoped HTTP interceptors for controller execution.

## 0.3.0

### Minor Changes

- 5ed8b54: Add opt-in Standard Schema validation for route params, query input and bounded JSON request bodies, with safe client-input HTTP responses.

## 0.2.2

### Patch Changes

- 4e8ce9c: Docs: install from npm without a dist-tag. Stable releases are now published on `latest`; release candidates go to `next`.
- Updated dependencies [4e8ce9c]
  - @strata-sc/core@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [fd99136]
  - @strata-sc/core@0.2.1

## 0.2.0

### Minor Changes

- e2cf345: Add `@Post()`, `@Put()`, `@Patch()` and `@Delete()` next to `@Get()`. `HttpMethod` is now `"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`; every decorator shares `@Get()`'s path normalization, class-local metadata, declaration order and member restrictions, and its errors name the decorator used. `@strata-sc/analog` registers and executes all five methods on the Nitro router through the same registration preflight (route identity stays HTTP method + final path) and request-scoped invocation.

  `StrataAnalogRequest` body readers now also work on Nitro's Cloudflare (workerd) presets, where the request body is attached to a non-streamable mock Node request instead of being streamed.

### Patch Changes

- 52c9fe9: Validate the whole `registerControllers()` batch before touching the router, so a configuration error no longer leaves earlier controllers partially registered. Registering the same HTTP method and final path twice through Strata on one router (in one call or across calls) now throws a `StrataAnalogConfigurationError` naming both handlers. Repeated calls with non-overlapping routes and separate routers are unaffected. A failure thrown by the router itself while routes are being added still propagates and is not rolled back.
- Updated dependencies [9090a52]
- Updated dependencies [e2cf345]
  - @strata-sc/core@0.2.0

## 0.1.0

### Minor Changes

- ad2463c: `controllerFactory` contexts can now register request-scoped cleanup callbacks (experimental).
  `StrataAnalogControllerFactoryContext` gains `onCleanup(cleanup)`, and the new
  `StrataAnalogCleanup` type (`() => void | Promise<void>`) is exported.

  A factory registers a cleanup for each resource it creates for a request, such as an Angular request
  injector, and Strata releases it once the controller invocation is over:

  - every registered cleanup runs exactly once, after the factory and the awaited handler call have
    settled: on success, when the factory throws or rejects, and when the handler throws or rejects;
  - async cleanups are awaited one at a time, and the route handler settles (and the response is
    sent) only after all of them;
  - cleanups run in LIFO order, last registered first;
  - every cleanup is attempted even if another fails. The original error is rethrown if only the
    invocation failed, a single cleanup error is thrown as is after a successful invocation, and
    otherwise an `AggregateError` holds the original error (if any) followed by every cleanup error.

  Cleanup covers the controller invocation, not a streamed response body. `onCleanup` throws
  `StrataAnalogConfigurationError` if it is called after the invocation has finished. The default
  factory (`new Controller()`) behaves as before, and `@strata-sc/analog` still has no Angular
  dependency.

- 2734104: Add `@strata-sc/analog`, an experimental Strata adapter for Analog 2 (Nitro 2, H3 v1). Its single
  public primitive, `registerControllers(router, controllers)`, reads controller metadata via
  `@strata-sc/core`'s `getControllerDefinition` and registers each `@Get()` route on the Nitro router
  (`nitroApp.router`, obtained in a Nitro server plugin), returning each handler's result directly to
  Nitro/H3.

  It is a sibling of `@strata-sc/h3`, not a wrapper: it does not depend on `@strata-sc/h3`, `h3`,
  `nitropack` or `@analogjs/*`. The router is typed structurally (`NitroRouter`), and Nitro's real
  `Router` type is assignable to it without a cast.

  Controller lifecycle is provisional: each controller is instantiated once, with
  `new ControllerClass()`, at registration time. Handlers may accept one provisional
  `StrataAnalogRequest` argument for route params, query values, headers, URL/path, context and lazy
  body readers; the H3 event is not exposed. There is no dependency injection, request scope or
  non-GET method yet.

- 77eec41: **Behavior change:** controller instances are now created per request instead of once during
  registration. `registerControllers()` still reads and validates controller metadata at startup
  (missing `@Controller()`, and route handlers that are not methods on the controller's prototype
  chain, still fail fast), but it no longer calls `new Controller()`. Each matching request creates a
  new controller instance, invokes the handler on it with that request's `StrataAnalogRequest`, and
  drops it. Instances are never cached, pooled or shared, so state kept on a controller no longer leaks
  between requests. The previous shared-instance lifecycle was provisional and is not kept.

  Add an experimental controller factory seam: `registerControllers(router, controllers, {
controllerFactory })`. The factory receives the controller class and a
  `StrataAnalogControllerFactoryContext` (`{ request }`, the same request object the handler receives)
  and returns the controller instance, synchronously or as a promise. Without it, Strata uses
  `new Controller()`. Factory errors and rejections propagate to Nitro unchanged; a result that is not
  an instance of the controller class throws `StrataAnalogConfigurationError` at request time. New
  public types: `StrataAnalogControllerFactory`, `StrataAnalogControllerFactoryContext` and
  `RegisterControllersOptions`.

  The factory is an extension seam, not a DI implementation: `@strata-sc/analog` still has no Angular
  dependency and provides no injector or container.

### Patch Changes

- Updated dependencies [80341ea]
  - @strata-sc/core@0.1.0
