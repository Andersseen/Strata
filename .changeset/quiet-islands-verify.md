---
"@strata-sc/server-components": minor
---

Browser client-reference descriptors with any property other than `type` and `expectedSelector` are now refused as a `reference` failure before any boundary of the host is created, instead of being accepted silently. Generated surrogates are unaffected.
