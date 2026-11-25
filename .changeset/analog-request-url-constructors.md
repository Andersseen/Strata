---
"@strata-sc/analog": minor
---

`request.url` no longer invents `http://localhost` on Node. Its path and query are always the
routed request target, and an absolute-form or `//host` target can never choose its origin. The
origin is the new `publicOrigin` option of `registerControllers()` when set, the only value to
compare with a browser's `Origin` header. Otherwise it is transport information: the URL the runtime
received (Cloudflare, H3's web adapter), or on Node the checked `Host` header with the socket's real
TLS state. `X-Forwarded-*` is never read. Without usable information the origin is the reserved
`http://strata.invalid`, which no browser origin can equal. An invalid `publicOrigin` is refused at
registration.

Controllers whose constructors take parameters can now be registered with a `controllerFactory`
that builds them, without a cast. `ControllerClass` is still the zero-argument class Strata
constructs by default. The new `ControllerConstructor` type and a second `registerControllers()`
overload accept any constructor only together with a factory typed for those classes.
`StrataAnalogControllerFactory` and `RegisterControllersOptions` take an optional type parameter
whose default keeps existing code unchanged.
