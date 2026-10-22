---
"@strata-sc/analog": minor
---

Add an opt-in HTTP routing and API boundary contract. `registerControllers()` accepts `apiBoundary: { prefixes, nativeRoutes?, head?, options? }` to explicitly own API path prefixes: unknown paths below them answer a safe JSON `404` instead of Analog's HTML shell, known paths with an unsupported method answer `405` with an accurate `Allow`, `HEAD` is derived from the matching `GET` route (one pipeline run, no body), and plain `OPTIONS` can be answered without ever answering or enabling CORS. Native Nitro routes, Analog pages and server functions are never shadowed, framework 404/405 answers run no guard, interceptor or controller factory, and registration validates prefixes, native declarations and route patterns before touching the router. Without the option, behavior is unchanged.
