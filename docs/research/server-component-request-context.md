# Server Component request context

Evidence report for the first request-context increment. Baseline: `b282aa66109e3f604019a99c8164324f6d910945` (`main`), tested 2026-10-14.

## Contract and investigated APIs

The installed tuple is Node 22.23.1, Angular core/compiler/common/router 22.1.7,
Angular platform-browser/platform-server 22.2.1, Analog 2.7.2, Nitro 2.13.4,
Vite 8.3.0 and TypeScript 6.0.3. Angular 22 publicly provides `REQUEST_CONTEXT`,
an SSR-only token whose missing value is `null`. Analog's public
`render(root, config, platformProviders)` forwards those providers to each
`renderApplication` call, alongside its own per-render request providers.

The fixture provides an immutable synthetic value through `REQUEST_CONTEXT` from
`main.server.ts`. Server Components and a server-only service inject that token
with `{ optional: true }`. No Strata token, second injector, generated-module
patch, `AsyncLocalStorage`, process-wide request store or controller scope is
introduced. The same Angular application injector created for the render is the
DI boundary for the parent, nested child and service.

The missing-context contract is explicit: injection returns `null`; the fixture
renders `missing` and does not select another request's value.

## Evidence

`pnpm test:server-component-request-context` builds the fixture twice and runs:

- Nitro `node-server`: two rounds of 24 overlapping SSR requests, alternating
  `alpha`/`beta`, then reversing the order;
- Cloudflare Pages through local Wrangler/workerd with the same two rounds;
- a deterministic 12-arrival barrier across each 24-request round, not a timer delay;
- parent, nested child and server-only service assertions for the same identity;
- a missing-context request after the server starts;
- browser-output and server-output scans for the synthetic confidential value;
- a minimal client island, proving ordinary hydration output remains present.

Both runtimes passed with zero failing checks. The confidential value is consumed
by server logic and appears in neither browser output nor the SSR response.

## Rejected alternatives and limits

Analog's controller request scope is a separate Nitro lifecycle and is not the
Angular SSR injector. Reusing it would not represent the same render. Creating a
Strata-owned injector would create a second DI universe. AsyncLocalStorage would
not qualify for workerd portability. Angular private internals and Analog
generated modules were not used.

This is request context for buffered document SSR only. It is not authentication,
authorization, sessions, tenant isolation, caching isolation, Angular Router
navigation, streaming SSR or a shared controller/SSR DI contract. Angular Router
navigation and streaming remain unsupported. The context lifetime is one
`renderApplication` call and ends when Angular destroys that render's platform.

## Verdict

**GO, narrow and experimental.** The public Angular mechanism is sufficient for
request-scoped Server Component reads on the tested Node and workerd tuple, with
concurrent isolation and safe absence. This does not qualify overall tenant
isolation, authorization or Strata 1.0.
