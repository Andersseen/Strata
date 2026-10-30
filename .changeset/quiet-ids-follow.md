---
"@strata-sc/analog": minor
---

Add opt-in request correlation. `registerControllers(router, controllers, { requestCorrelation: true })` generates one random `crypto.randomUUID()` per Strata controller invocation, exposes it as `request.correlationId` to guards, interceptors, the controller factory and the handler, and as `correlationId` on the `onRequestSettled` observation. It is disabled by default (no identifier, no new observation field), never derived from request data, never added to a response, and is not an identity or authorization value.
