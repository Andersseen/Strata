---
"@strata-sc/core": patch
---

`STRATA_VERSION` now reports the published package version. It was still `"0.1.0"` in 0.2.0; the build now inlines it from `package.json`, so it can no longer drift on release.
