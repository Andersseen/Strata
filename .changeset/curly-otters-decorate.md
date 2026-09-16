---
"@strata/core": minor
---

Add the first `@strata/core` primitive: `@Controller` and `@Get` standard
decorators for declaring HTTP controllers and GET routes as framework-agnostic
metadata, plus `getControllerDefinition` for reading that metadata back. This
does not wire up any HTTP runtime (no H3 integration yet) — it only defines
how Strata describes controllers and routes.
