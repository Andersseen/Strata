# Server Component SSR response and recovery

Date: 2026-10-14
Baseline: `main` at `7738b475fd82e1e6f4db8dcb642e4092c42f9356`
Branch: `feat/server-components-ssr-error-response`

## Question

Can a buffered Angular Server Component render failure produce an honest HTTP error and a
safe fallback through public Angular/Analog APIs, without private compiler state, global mutable
state or a package API change? If not, can an application-owned expected service failure still
recover explicitly and safely?

## Pinned tuple

The fixture resolved this installed tuple:

| Runtime/package                            | Version    |
| ------------------------------------------ | ---------- |
| Node                                       | 22.23.1    |
| Angular core/common/compiler/router        | 22.1.7     |
| Angular platform-browser                   | 22.2.1     |
| Angular platform-server                    | 22.2.2     |
| Analog platform/router/vite-plugin-angular | 2.7.2      |
| Nitro                                      | 2.13.4     |
| h3 (Nitro resolution)                      | 1.15.11    |
| Vite                                       | 8.3.0      |
| TypeScript                                 | 6.0.3      |
| Playwright                                 | 1.62.1     |
| Wrangler local compatibility date          | 2026-09-21 |

## Baseline and public API investigation

The existing `pnpm test:server-component-failures` gate reproduces three unexpected render
failures on both Nitro and local workerd. Constructor and injected-service failures return HTTP
200 with `text/html` and an empty `<router-outlet>` shell (890 bytes in the fixture). A template
failure returns HTTP 200 with a 2102-byte half-rendered document: text before the throw remains,
the trailing binding is empty, and the boundary has no `data-strata-*` attributes. Each reports
once to Angular's `ErrorHandler`; the public body is sanitized. Serialization, preflight,
commit-rollback, sibling isolation and document navigation have the existing safe boundaries
documented in the [failure report](server-component-failure-recovery.md).

The installed source and declarations were inspected rather than relying on private symbols:

- Angular publicly exports `RESPONSE_INIT` (`ResponseInit`), `REQUEST`, and `REQUEST_CONTEXT`.
  `RESPONSE_INIT` has a platform default of `null`, and Angular platform-server does not provide a
  response implementation for the Analog handler to consume. `BEFORE_APP_SERIALIZED` and the
  `ErrorHandler` are public, but neither is a general response-status bridge.
- Analog's public server renderer accepts `platformProviders` and forwards them to
  `renderApplication`, but its public `render` contract returns only an HTML string. It does not
  translate a thrown render error or `RESPONSE_INIT` value into an HTTP response.
- Analog's public `REQUEST`/`RESPONSE` tokens expose the server request and mutable Node response.
  The public Nitro renderer passes `event.node.req` and `event.node.res` to that renderer. This is
  a consumer-owned response path: code that owns an expected domain failure can set the response
  status before returning rendered HTML.

Rejected mechanisms:

- A global `ErrorHandler` that rethrows would alter unrelated Angular failures and still does not
  provide a safe fallback HTML response.
- `RESPONSE_INIT` alone is not sufficient: no Analog/platform-server adapter was found that reads
  it for a general render failure.
- Private Angular/Analog compiler/bootstrap symbols, generated-module patching and process/global
  state were not used.
- Streaming and true SPA Server Component subtree navigation remain outside this buffered,
  document-response contract.

## Implemented consumer-owned recovery

The fixture now has `/server-component-ssr-recovery`:

- `RecoveryRepository` throws a typed, expected private failure only for the explicit
  `?mode=unavailable` scenario and returns a safe count for success.
- `RecoveryService` catches only that typed failure, sets the public Analog `RESPONSE` status to
  503 with `cache-control: no-store`, and returns a discriminated generic fallback result.
  Missing or malformed request context is an explicit 400/no-store result. Unexpected exceptions
  are rethrown into Angular rather than being misclassified as expected recovery.
- The Server Component renders either repository-backed success or generic fallback HTML. The
  private error and canary never appear in the body, headers, browser output or client graph.
- This is a fixture/application pattern, not a new Strata package API or a general render-error
  response guarantee. No changeset is warranted.

## Verification

Command: `pnpm test:server-component-ssr-response`

The gate passed with zero failures for both runtimes:

- production Nitro node-server: healthy 200, expected failure 503/no-store, invalid context 400,
  unrelated route 200, recovery after failure, overlapping success/failure isolation;
- Nitro browser document navigation: failure receives 503, Back returns to a new healthy document,
  re-entry receives 503 without browser errors;
- Cloudflare Pages build and local Wrangler/workerd: the same response, isolation and navigation
  checks;
- constructor, injected-service and template failures remain HTTP 200 controls, proving the new
  recovery path does not falsely claim to repair unexpected Angular render errors.

## Verdict

| Question                                           | Verdict                                     |
| -------------------------------------------------- | ------------------------------------------- |
| Expected server-side service recovery              | **GO**, narrow and consumer-owned           |
| HTTP status for an expected service failure        | **GO**, through public Analog `RESPONSE`    |
| General unexpected Server Component render status  | **NO-GO**; still HTTP 200 in Angular/Analog |
| Node production SSR for this recovery pattern      | **GO**, narrow                              |
| Local Cloudflare workerd for this recovery pattern | **GO**, narrow                              |
| Confidentiality of this fixture's expected error   | **GO**, with synthetic canary checks        |
| Streaming SSR                                      | **UNSUPPORTED**                             |
| True SPA Server Component navigation               | **UNSUPPORTED**                             |
| Strata 1.0                                         | **NOT YET QUALIFIED**                       |

The existing [failure gate](server-component-failure-recovery.md) and
[`pnpm test:server-component-security`](../TESTING.md) remain required evidence. The full render
failure criterion stays open because unexpected render errors still produce HTTP 200 and there is
no general fallback/recovery API.
