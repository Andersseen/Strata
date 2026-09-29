---
"@strata-sc/core": minor
"@strata-sc/analog": minor
---

Add `@Post()`, `@Put()`, `@Patch()` and `@Delete()` next to `@Get()`. `HttpMethod` is now `"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`; every decorator shares `@Get()`'s path normalization, class-local metadata, declaration order and member restrictions, and its errors name the decorator used. `@strata-sc/analog` registers and executes all five methods on the Nitro router through the same registration preflight (route identity stays HTTP method + final path) and request-scoped invocation.

`StrataAnalogRequest` body readers now also work on Nitro's Cloudflare (workerd) presets, where the request body is attached to a non-streamable mock Node request instead of being streamed.
