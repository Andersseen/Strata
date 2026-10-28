---
"@strata-sc/server-components": minor
---

Validate client reference identity at runtime. Generated surrogates now carry the build-authorized selector of each client component, and `provideClientReferences` accepts `{ type, expectedSelector }` descriptors beside plain component types (existing arrays stay valid). A host whose references are not Angular components, whose actual selector differs from the authorized one, or where two distinct components claim one selector, refuses all its boundaries as a `reference` failure before any island is created, instead of silently keeping the last component for a selector.
