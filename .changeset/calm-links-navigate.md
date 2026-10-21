---
"@strata-sc/server-components": minor
---

Add first-class document navigation for Server Component routes to the optional `/navigation` entry: `StrataDocumentLink` (a native anchor whose `href` is resolved from Angular route commands, a `UrlTree` or a root-relative string, with query parameters, fragment and base href), `StrataDocumentNavigator` (explicit programmatic document navigation that never calls `Router.navigate()`), and a hardened `strataDocumentNavigationGuard` that respects the base href and cannot reload-loop. All three share one same-origin URL resolver built on Angular's public `Router`, `UrlSerializer` and `Location`. The Vite plugin now also pre-bundles the `/navigation` entry for the dev server when the app has `@angular/router`. Angular Router navigation into an unprotected Server Component route is still unsupported.
