---
"@strata-sc/server-components": minor
---

Make client reference validation fail closed. `buildClientReferenceRegistry` now reads descriptors as own data properties without invoking consumer getters, `toString` or `valueOf`, requires `expectedSelector` to be a custom-element name, and turns throwing accessors, hostile proxies, corrupt Angular component metadata and non-array registries into a classified `reference` refusal that never echoes consumer values. Plain component-type arrays and generated descriptors are unchanged.
