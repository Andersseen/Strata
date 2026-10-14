# Server Component request-scoped service isolation

Evidence report for the request-service isolation increment. Baseline:
`e06fae597f691933db3c47b7a5bf4c1ba3990472` (`main`), tested 2026-10-14.

## Scope and tuple

This slice extends the Angular `REQUEST_CONTEXT` integration from PR #71. The
installed tuple is Node 22.23.1, Angular core/compiler/common/router 22.1.7,
Angular platform-browser/platform-server 22.2.1, Analog 2.7.2, Nitro 2.13.4,
Vite 8.3.0 and TypeScript 6.0.3. The mechanism remains Analog's public
`render(..., platformProviders)` seam; no Strata request API, second injector,
global request store or Node-only async context was added.

The parent Server Component provides `RequestContextFixtureService` in its
component injector. The nested server-owned child injects that service and
receives the parent reference as a server-only input. The rendered `shared`
marker proves the parent and child use the same instance within one render.

## Identity rules

The fixture resolver allow-lists only `alpha` and `beta`. The route and optional
resource query are untrusted test inputs; they are not authentication or
authorization credentials. The trusted context contains only the resolved
identity, round and read/fail operation.

| Input                                        | Observed behavior                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| missing context (`?missing=true`)            | HTTP 200 with an empty safe render; no actor is selected               |
| unknown identity (`/gamma`)                  | HTTP 200 with an empty safe render; no fallback to alpha               |
| malformed identity (`/%20alpha`)             | HTTP 200 with an empty safe render                                     |
| mismatched resource (`/alpha?resource=beta`) | HTTP 200 with an empty safe render                                     |
| repository failure (`/alpha?fail=true`)      | HTTP 200 without a verified result; the following beta render succeeds |

These HTTP 200 responses are the current Angular/Analog behavior when the
platform provider rejects and Angular omits the routed component. The fixture
asserts the empty safe render rather than claiming an HTTP rejection.

## Isolation and confidentiality evidence

`alpha` and `beta` use distinct synthetic private canaries:
`STRATA_REQUEST_PRIVATE_ALPHA_5B7C9D1E` and
`STRATA_REQUEST_PRIVATE_BETA_2F8A4C6D`. The server-only repository consumes the
identity-specific value and exposes only `alpha:verified` or `beta:verified`.
The test requires both canaries in the server graph, neither in browser output,
the correct parent/child/service identity in every response, and the client
island's public `client-ready 0` output.

`pnpm test:server-component-request-context` runs two 24-request overlapping
rounds per runtime (alternating order and reversed order), sequential renders
with fresh contexts, all four invalid-context cases, repository failure and
immediate recovery. Each render holds the service operation for 250ms and each
request has a bounded timeout.

The same gate qualifies Nitro `node-server` and Cloudflare Pages local
workerd. It does not qualify a deployed Cloudflare application, authenticated
identity, authorization, tenant-aware caching, sessions, Angular Router
navigation, streaming SSR or shared controller/SSR DI.

## PR #71 and security-gate characterization

GitHub Actions run `38521498679` completed with overall `failure`: its
request-context job failed, while the preceding Server Component data
confidentiality job passed. The local Server-Timing/module-name assertion issue
was therefore not treated as a data leak or weakened. The current
`pnpm test:server-component-security` result is tracked separately from this
fixture's isolation result.

## Verdict

**GO, narrow and experimental**, once the focused gate and required repository
checks pass. This is synthetic request/data isolation evidence, not a claim of
real authentication, authorization or tenant security.
