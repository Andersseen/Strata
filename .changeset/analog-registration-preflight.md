---
"@strata-sc/analog": patch
---

Validate the whole `registerControllers()` batch before touching the router, so a configuration error no longer leaves earlier controllers partially registered. Registering the same HTTP method and final path twice through Strata on one router (in one call or across calls) now throws a `StrataAnalogConfigurationError` naming both handlers. Repeated calls with non-overlapping routes and separate routers are unaffected. A failure thrown by the router itself while routes are being added still propagates and is not rolled back.
