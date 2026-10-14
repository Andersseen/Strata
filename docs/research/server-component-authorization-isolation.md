# Server Component request-bound authorization isolation

Date: 2026-10-14  
Baseline: `4ffee83d874c86d425d5c6ea21191bbb290e5e2c` (`main`)  
Branch: `test/server-components-authorization-isolation`

## Verdict first

This is a **fixture-only, synthetic authorization qualification** for buffered
Angular Server Component document SSR. It proves that a request with a trusted
test cookie can read only its own synthetic tenant resource, while route,
query and arbitrary header values cannot select a principal. It does not
qualify production authentication, sessions, authorization APIs, tenant-aware
caching or Strata 1.0.

| Question                                    | Verdict                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Synthetic principal resolution              | **GO, narrow and fixture-owned**                                                                                          |
| Request-bound authorization                 | **CONDITIONAL GO** on the synthetic cookie trust model                                                                    |
| Cross-tenant access prevention              | **GO, narrow** on Node and local workerd                                                                                  |
| Node buffered SSR                           | **GO, narrow**                                                                                                            |
| Cloudflare local workerd                    | **GO, narrow**                                                                                                            |
| Browser confidentiality                     | **CONDITIONAL GO**; protected values stay server-owned, but public SSR is intentionally visible to the authorized browser |
| Production authentication                   | **NOT QUALIFIED**                                                                                                         |
| Production tenant/cache isolation           | **NOT QUALIFIED**                                                                                                         |
| Unexpected Angular render-error HTTP status | **STILL UNSUPPORTED AS A GENERAL GUARANTEE**                                                                              |
| True SPA Server Component navigation        | **UNSUPPORTED**                                                                                                           |
| Streaming SSR                               | **UNSUPPORTED**                                                                                                           |
| Strata 1.0                                  | **NOT YET QUALIFIED**                                                                                                     |

## Scope and trust model

The route is `/server-component-authorized/:tenant`. `alpha` and `beta` are
synthetic tenants. Each has an opaque synthetic credential, a private
server-only repository canary and a safe public label.

The only trusted identity input is exactly one
`__strata_test_credential` cookie whose value matches the fixture's opaque
alpha or beta credential. Missing, unknown, malformed or duplicate credential
cookies resolve to no principal. A browser receives the cookie as `HttpOnly`.
There is no credential-granting endpoint and no real secret.

The route parameter is an untrusted resource identifier. Query parameters and
`X-User`/`X-Tenant` headers are ignored for identity resolution. An alpha
cookie requesting `/beta` is an authenticated-but-forbidden request; changing
`?principal=beta`, `?tenant=beta` or `?resource=beta` cannot change the
principal or requested path resource.

This is a test trust model, not an identity provider. It deliberately does not
implement login, OAuth/OIDC, JWTs, session management, credential rotation,
revocation, roles, permissions or a public Strata authentication API.

## Public Angular/Analog seams

`main.server.ts` keeps the existing Angular `REQUEST_CONTEXT` provider and
adds one independent request-scoped `AUTHORIZATION_CONTEXT` provider. Its
factory reads Analog's public per-render `REQUEST` token and resolves the
synthetic cookie. No process-global principal, `AsyncLocalStorage`, second DI
container, private Angular API or generated Analog module patch is used.

The protected Server Component receives the route's requested tenant through a
fixture-local Angular token. That token is deliberately separate from the
verified principal. The service injects Analog's public `RESPONSE` token to set
controlled status and `cache-control: no-store` headers.

## Authorization-before-read ordering

The request-local flow is:

1. Resolve the cookie into a synthetic principal or `null`.
2. Validate the requested route tenant against the allow-list.
3. Deny missing/invalid credentials with `401`.
4. Compare the verified principal tenant with the requested resource tenant.
5. Deny a mismatch with `403`.
6. Only after the ownership check, read the protected repository record.
7. Render only its safe public label and pass only the safe tenant name to the
   client island.

The repository has a request-local `AuthorizationReadTrace`. It records a read
only when the repository method executes and is rendered as
`data-resource-read`. Every denied, anonymous, invalid and unknown-resource
response records `none`. This is test instrumentation, not application auth
state; removing the ownership check makes the cross-tenant gate fail.

Known resources use `403` for authenticated cross-tenant access so the fixture
explicitly demonstrates the distinction. Unknown or malformed resources use
`404` to avoid returning a protected record and to leave resource-enumeration
policy explicit. All protected responses, including successful ones, use
`cache-control: no-store`; this increment introduces no shared data cache.

## HTTP and concurrency evidence

`pnpm test:server-component-authorization` uses actual HTTP responses against
the production Nitro build and local Wrangler Pages/workerd build. It covers:

- alpha → alpha and beta → beta: `200`, `text/html`, `no-store`, own safe
  public label, client boundary, repository read for the same tenant;
- alpha → beta and beta → alpha: `403`, generic forbidden HTML, `no-store`,
  `data-resource-read="none"`;
- no, unknown, malformed and duplicate credentials: `401`, generic
  unauthenticated HTML, `no-store`, no repository read;
- query principal/resource overrides and untrusted identity headers: ignored;
- unknown and malformed resource identifiers: `404`, generic not-found HTML,
  `no-store`;
- a denied request followed by an authorized request;
- the existing expected repository failure (`503`) followed by an authorized
  request;
- two 24-request rounds with mixed valid, denied, anonymous and invalid
  requests, forward and reversed, with bounded request time.

Both runtimes passed with zero failing checks. The build scan found both
synthetic credentials and both private resource canaries in the server graph
and none in browser output, including source maps and public assets.

## Browser and document navigation evidence

Playwright uses a browser context cookie with `HttpOnly`. JavaScript cannot read
the credential. An authorized direct document returns `200`, reuses the SSR
DOM for the client island, and one click produces exactly one interaction.
Navigation to beta with the alpha cookie returns a real `403` document with no
client island. Back returns to authorized `200` SSR; Forward and refresh return
the forbidden `403` document; a fresh authorized re-entry works. No console or
page errors were observed on Node or workerd.

The authorized public label and tenant marker are intentionally visible to
that authorized browser. The private repository canaries, raw credentials,
repository names and authorization context are absent from response bodies,
headers, boundary props and browser-visible assets. This does not claim that
Strata can hide data deliberately rendered into authorized HTML.

## Installed qualification tuple

The gate prints the installed tuple:

| Runtime/package                            | Version      |
| ------------------------------------------ | ------------ |
| Node                                       | 22.23.1      |
| Angular core/common/compiler/router        | 22.1.7       |
| Angular platform-browser                   | 22.2.1       |
| Angular platform-server                    | 22.2.2       |
| Analog platform/router/vite-plugin-angular | 2.7.2        |
| Nitro                                      | 2.13.4       |
| Vite                                       | 8.3.0        |
| TypeScript                                 | 6.0.3        |
| Playwright                                 | 1.62.1       |
| Wrangler compatibility date                | `2026-09-21` |

## Limits and residual risks

- Synthetic cookies are not production authentication or secure session
  management.
- Authorization is fixture-owned; no package decorator, guard or service API
  was added.
- There is no deployment qualification, origin/CSRF policy, credential
  rotation, revocation, audit-log redaction or third-party error-reporter
  qualification.
- `no-store` avoids this fixture's shared-cache risk but does not qualify a
  general tenant-aware cache design.
- Unexpected Angular/Analog render failures retain the known HTTP 200 empty or
  partial buffered document behavior.
- Angular Router subtree hydration and streaming remain unsupported.

## Reproduction

```text
pnpm test:server-component-authorization
```

The existing request-context, data-security, SSR-response and failure gates
remain required regression controls. No package is published and no production
Cloudflare resource is changed.
