# @strata-sc/server-components

## 0.7.0

### Minor Changes

- 6094c6a: Make the production compilation contract a build-time guarantee. Analog builds the `client` and `ssr` environments concurrently with one shared Angular plugin, which discards its compilation output when the first environment ends; an environment still transforming then received no compiled output for its files, and Analog skipped them without failing, so a page or component reached the production server as an uncompiled `@Component` and Angular fell back to the JIT compiler on the first request (`JIT compiler unavailable`, HTTP 200, empty or partial document). The Vite plugin now holds each environment at `buildEnd` until every environment of the build has finished transforming, using only public Rollup hooks, and a post-transform gate fails a production build, naming the module, environment and class, when a source-owned Angular class still applies its decorator or a bundled package still contains unlinked partial declarations (`ɵɵngDeclare*`). Valid builds are unchanged; a build that used to succeed and ship a server that could not render a component now fails with an actionable error. No option or API was added.

## 0.6.0

### Minor Changes

- 2c1d73c: Harden the server-only build graph. The pre-scan now follows re-exports through Vite `resolve.alias`, tsconfig `paths` / `baseUrl`, `index` files and `.js` → `.ts` specifiers (new optional `tsconfig` plugin option), using a per-generation resolver that can only answer with a scanned module and never crawls `node_modules`. The client environment checks the resolved identity of aliased specifiers before Vite loads them, and still refuses any forbidden module at `load`, so an unmodelled resolution form cannot become a bypass. A package module that asserts `@strata-sc/server-components/server-only` fails the client build whether or not the package is registered in `clientComponents`. Diagnostics now include the import chain the bundler reports, print app-relative paths (a dependency from its last `node_modules/` segment, never an arbitrary absolute path), and say `unavailable` instead of guessing an importer. Dev regeneration follows aliased ownership changes and re-reads the governing tsconfig. Existing islands, package islands and protocol v1/v2 are unchanged.

## 0.5.0

### Minor Changes

- ff91362: Add first-class document navigation for Server Component routes to the optional `/navigation` entry: `StrataDocumentLink` (a native anchor whose `href` is resolved from Angular route commands, a `UrlTree` or a root-relative string, with query parameters, fragment and base href), `StrataDocumentNavigator` (explicit programmatic document navigation that never calls `Router.navigate()`), and a hardened `strataDocumentNavigationGuard` that respects the base href and cannot reload-loop. All three share one same-origin URL resolver built on Angular's public `Router`, `UrlSerializer` and `Location`. The Vite plugin now also pre-bundles the `/navigation` entry for the dev server when the app has `@angular/router`. Angular Router navigation into an unprotected Server Component route is still unsupported.

## 0.4.0

### Minor Changes

- 7183d0b: Allow explicitly registered Angular components from installed packages to be used as `[strataClient]` islands, with package imports in AOT-compiled surrogates and the existing safe v1/v2 hydration protocol.

## 0.3.0

### Minor Changes

- fe41a5f: Add bounded readonly structured props for `[strataClient]` with browser hydration through boundary
  protocol v2, while preserving protocol v1 for flat primitive payloads. Server serialization and
  browser preflight share strict recursive validation and independent snapshots, with explicit depth,
  node, key, array and UTF-8 byte limits to reject unsafe values at both sides of the boundary.

## 0.2.1

### Patch Changes

- 4e8ce9c: Docs: install from npm without a dist-tag. Stable releases are now published on `latest`; release candidates go to `next`.

## 0.2.0

### Minor Changes

- ddf052e: Add the experimental `@strata-sc/server-components/navigation` entry with an opt-in
  `strataDocumentNavigationGuard` for same-origin document navigation into designated Server Component routes.

## 0.1.0

### Minor Changes

- 92f4dfa: First experimental release of `@strata-sc/server-components` (`next` channel, API may change before 1.0).

  Server Components for Angular and Analog with explicit client boundaries:

  - `@ServerComponent()` with a build-time server-only graph separation: the server implementation never enters the browser graph.
  - Recursive server composition and `[strataClient]` client islands over boundary protocol v1, with Angular hydration reusing the SSR DOM.
  - Angular-owned `@defer` support.
  - `import "@strata-sc/server-components/server-only"` module assertion, enforced as a build error if the module reaches the browser graph.
  - Vite plugin (`@strata-sc/server-components/vite`) with dev-server graph regeneration.
  - Qualified on Node/Nitro and Cloudflare/workerd (local) with buffered SSR and document navigation. Router navigation into a new Server Component subtree and streaming SSR are not supported.
