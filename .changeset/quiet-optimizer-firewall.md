---
"@strata-sc/server-components": minor
---

Enforce the server-only assertion inside Vite's dependency optimizer. A package module that imports `@strata-sc/server-components/server-only`, directly, through a package re-export or through a dynamic import, is now refused when the dev server pre-bundles it for the browser (Vite 8 pre-bundles with Rolldown, which resolved the assertion without the plugin ever seeing it, so the forbidden implementation was served). The refusal produces no chunk and names the module and the importers the optimizer reports. A `[strata]` dev error no longer carries the failing module's code frame or source in its HTTP and overlay payload. The plugin adds a public `optimizeDeps.rolldownOptions.plugins` entry only; there is no new option.
