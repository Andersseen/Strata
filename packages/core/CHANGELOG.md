# @strata-sc/core

## 0.2.0

### Minor Changes

- e2cf345: Add `@Post()`, `@Put()`, `@Patch()` and `@Delete()` next to `@Get()`. `HttpMethod` is now `"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`; every decorator shares `@Get()`'s path normalization, class-local metadata, declaration order and member restrictions, and its errors name the decorator used. `@strata-sc/analog` registers and executes all five methods on the Nitro router through the same registration preflight (route identity stays HTTP method + final path) and request-scoped invocation.

  `StrataAnalogRequest` body readers now also work on Nitro's Cloudflare (workerd) presets, where the request body is attached to a non-streamable mock Node request instead of being streamed.

### Patch Changes

- 9090a52: Make controller metadata class-local. A subclass of a controller no longer inherits `@Controller()` or its `@Get()` routes (an undecorated subclass has no definition), and decorating a subclass no longer writes routes into its base class or siblings. `@Get()` now throws a `TypeError` at class definition when applied to a static or private method.

## 0.1.0

### Minor Changes

- 80341ea: Add the first `@strata-sc/core` primitive: `@Controller` and `@Get` standard
  decorators for declaring HTTP controllers and GET routes as framework-agnostic
  metadata, plus `getControllerDefinition` for reading that metadata back. This
  does not wire up any HTTP runtime (no H3 integration yet) — it only defines
  how Strata describes controllers and routes.
