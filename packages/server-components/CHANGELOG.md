# @strata-sc/server-components

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
