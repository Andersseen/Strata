# Full-stack authorization and tenant-isolation qualification

## Scope and identity

Starting `main`: `55be0abae0440c42b86f8a53a77638c582aa3ae7`. This qualification extends the existing external full-stack consumer fixture. The package tuple is `@strata-sc/core@0.2.2`, `@strata-sc/analog@0.12.0`, `@strata-sc/server-components@0.14.0`. Source-packed SHA-256 values: `49434df58bb205fb1a69c07eb1b9b6cb334b2e1b7161343f1cbbc0167995bfcb`, `76c48ae27b024f29ff96fce5f17e3d5e5c82aa1f11f1671f06025b514394afaa`, and `16869a3b7a92d15853c7a9986a6134faf97683290c7f8e554195068283af2fae`. Registry artifacts were independently downloaded and matched to metadata and lock integrity: core `sha512-Xr6bMt7funa/RtMhr/BTLX548alI8w5/tq/4QIgvk4INEc4nED5CweQUeEujPU6o9/NcJ1XFtqcXPNGjohkHFA==`; Analog `sha512-jHkt/GbJ3nMvzwuVzRnDYQ6dfTPpcEN7jm+qGADvP0whTKs56qT/QkR9lmJ9vnSfrxyNgmt8jIl2n963BjWAuA==`; Server Components `sha512-GoaNuTU/cOJgVme9hyXziAjD7bmszRmxZUah8yaDUcrMv7T5Kw/qgH4IJSqILs6Q8Ng78VssKq5MXugQWkj7bw==`.

The only accepted identity source in the fixture is one cookie named `strata-test-credential`, with opaque synthetic values for `alpha` and `beta`. Query parameters, identity headers, and resource-owner URL segments do not establish identity. A malformed, unknown, missing, or duplicated credential is rejected. This is test policy only; it implements no production authentication or session lifecycle.

## Integration seams

The Analog controller independently resolves the cookie from its `StrataAnalogRequest.headers` in a `StrataAnalogGuard`, registered with `registerControllers`. The Angular SSR path uses Analog's public `REQUEST` token supplied through the `render(..., platformProviders)` API and Angular's public `REQUEST_CONTEXT`. The Server Component independently resolves the cookie and checks ownership before calling the server-only repository. These paths do not share an Angular injector or process-global identity.

`/api/protected/:tenant/products/:id` returns 200 for the matching tenant, generic 401 for absent/invalid credentials, generic 403 for a different tenant, and generic 404 for unknown or malformed resources. `/protected/:tenant` uses the same status distinctions. All protected responses set `Cache-Control: no-store`. The authorized document contains a client island with a safe tenant prop; it calls the same-origin protected controller API and handles non-2xx responses without exposing credentials.

## Evidence status

| Evidence level           | Status                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMPLEMENTED              | Protected controller, SSR route, resolver, island and assertions extend the existing consumer.                                                                                         |
| PACKED CONSUMER          | PASS: `pnpm test:full-stack-package-consumer`, 402 checks; external installs, one compatible package copy each, no monorepo source resolution, strict TS 6.0.3 and 5.9.2 declarations. |
| LOCAL NODE               | PASS: Nitro production build, original and protected controller paths, SSR status/cache matrix, SSR/API isolation, graph and lifecycle/routing contracts.                              |
| LOCAL WORKERD            | PASS: Cloudflare Pages build and local Wrangler/workerd runtime, including protected HTTP and overlap assertions. Not a Cloudflare deployment.                                         |
| Chromium                 | PASS: alpha/beta docs hydrate and call their protected API; HttpOnly cookies stay hidden from `document.cookie`; cross-tenant SSR/API are denied and access recovers.                  |
| PUBLISHED REGISTRY       | PASS: `pnpm test:full-stack-registry-consumer`, 395 checks; exact artifacts above installed and qualified on Node, local workerd and Chromium.                                         |
| HOSTED CI                | NOT RUN                                                                                                                                                                                |
| DEPLOYED / REAL ADOPTION | NOT RUN                                                                                                                                                                                |

The API's test-only `x-fixture-protected-read` header appears only after its repository read; denied requests have no such header because the guard rejects before controller construction. SSR records zero reads on denied renders and one after an authorized read. Both runtimes passed the 200/401/403/404 and `no-store` matrix, plus 24 overlapping SSR requests across owner, cross-owner, anonymous and invalid-cookie cases. The API matrix exercises owner, cross-owner, missing, invalid, duplicate and unknown-resource requests concurrently, followed by a healthy request after denial. The negative controls in `full-stack-verify.ts` feed altered response transcripts to the verifier; they do not mutate the fixture source or rebuild a deliberately vulnerable app.

Browser output, source maps, API/SSR bodies and the server graph were scanned for private markers and synthetic credentials; public labels are intentionally displayed. Existing server-only firewall and routing negative controls also ran. The existing `pnpm test:server-component-security` control build disables graph protection and proves its scanner detects a private canary in browser output. Specific controls that mutate this authorization fixture to remove ownership checking or substitute beta data for alpha have **NOT RUN**. Hosted CI and remaining graph/Extended workflow jobs remain open. No GO verdict is made for the full M4/M5 gate.

## Limits

The fixture's credentials are synthetic and must not be treated as production credentials. No general authentication, secure session lifecycle, CSRF defense, shared caching isolation, cancellation behavior, shared SSR/controller DI, real application adoption, or Strata 1.0 readiness is established. The read-only test does not qualify mutation or CSRF behavior.
