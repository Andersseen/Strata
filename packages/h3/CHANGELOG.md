# @strata/h3

## 0.1.0

### Minor Changes

- b899c59: Add the first Strata HTTP adapter, `@strata/h3`, built on H3 v2
  (`h3@^2.0.1-rc.1`). Its single public primitive, `registerControllers(app,
controllers)`, reads controller metadata via `@strata/core`'s
  `getControllerDefinition`, registers each `@Get()` route on an H3 app you
  create and own, and invokes the matching controller method when H3 resolves
  a route — returning its result directly to H3.

  Controller lifecycle is provisional: each controller is instantiated once,
  with `new ControllerClass()`, at registration time. There is no dependency
  injection or request-scoped lifecycle yet.

  This does not add any new HTTP methods, parameter decorators, request
  context, or DI — only the minimal `@Controller`/`@Get` → H3 wiring.

### Patch Changes

- Updated dependencies [80341ea]
  - @strata/core@0.1.0
