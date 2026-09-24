---
"@strata/analog": minor
---

**Behavior change:** controller instances are now created per request instead of once during
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

The factory is an extension seam, not a DI implementation: `@strata/analog` still has no Angular
dependency and provides no injector or container.
