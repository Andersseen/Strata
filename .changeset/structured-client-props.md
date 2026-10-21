---
"@strata-sc/server-components": minor
---

Add bounded readonly structured props for `[strataClient]` with browser hydration through boundary
protocol v2, while preserving protocol v1 for flat primitive payloads. Server serialization and
browser preflight share strict recursive validation and independent snapshots, with explicit depth,
node, key, array and UTF-8 byte limits to reject unsafe values at both sides of the boundary.
