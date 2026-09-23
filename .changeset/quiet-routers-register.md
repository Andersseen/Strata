---
"@strata/analog": minor
---

Add `@strata/analog`, an experimental Strata adapter for Analog 2 (Nitro 2, H3 v1). Its single
public primitive, `registerControllers(router, controllers)`, reads controller metadata via
`@strata/core`'s `getControllerDefinition` and registers each `@Get()` route on the Nitro router
(`nitroApp.router`, obtained in a Nitro server plugin), returning each handler's result directly to
Nitro/H3.

It is a sibling of `@strata/h3`, not a wrapper: it does not depend on `@strata/h3`, `h3`,
`nitropack` or `@analogjs/*`. The router is typed structurally (`NitroRouter`), and Nitro's real
`Router` type is assignable to it without a cast.

Controller lifecycle is provisional: each controller is instantiated once, with
`new ControllerClass()`, at registration time. Handlers may accept one provisional
`StrataAnalogRequest` argument for route params, query values, headers, URL/path, context and lazy
body readers; the H3 event is not exposed. There is no dependency injection, request scope or
non-GET method yet.
