# @strata-sc/server-components

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
