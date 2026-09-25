# @strata-sc/analog

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
