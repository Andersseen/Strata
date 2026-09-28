---
"@strata-sc/core": patch
---

Make controller metadata class-local. A subclass of a controller no longer inherits `@Controller()` or its `@Get()` routes (an undecorated subclass has no definition), and decorating a subclass no longer writes routes into its base class or siblings. `@Get()` now throws a `TypeError` at class definition when applied to a static or private method.
