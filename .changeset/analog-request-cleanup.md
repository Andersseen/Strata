---
"@strata/analog": minor
---

`controllerFactory` contexts can now register request-scoped cleanup callbacks (experimental).
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
factory (`new Controller()`) behaves as before, and `@strata/analog` still has no Angular
dependency.
