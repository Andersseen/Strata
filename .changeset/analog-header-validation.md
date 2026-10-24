---
"@strata-sc/analog": minor
---

Add `request.validateHeaders(schema)`: opt-in Standard Schema v1 validation of a frozen, lowercase, string-valued header snapshot, with inferred output types. Invalid input answers the existing safe 400 with `source: "headers"`, follows cleanup-first precedence and is observed as `input-rejected`. Exports the `StrataAnalogHeaders` type.
