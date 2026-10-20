# Analog HTTP contract for 0.5.0

- Date: 2026-10-20
- Starting baseline: `0031b654058dc0658cab65eb2fd360b7dcad4b15` (`main`, synchronized with `origin/main` when work began)
- Current base: `ff1034def709abe2d92e13e2fcbb4b39e7fd1b77` after main advanced with Dependabot PR #92's Angular CDK patch update; the feature branch was rebased onto it
- Branch: `feat/analog-http-contract-v05`

## Scope and verdict

This increment completes a small application HTTP contract for
`@strata-sc/analog`: a typed expected-error class and native `Response` helpers
for JSON and empty success responses. It composes with the existing request
guards, interceptors, Standard Schema validation and cleanup scope. The feature
fixture demonstrates an authenticated inventory API with create, read, update
and delete routes.

**Fixture qualification: GO** for the tested Node Analog production/dev paths,
local Cloudflare Pages/workerd portable contract, packed external consumer,
and strict TypeScript 6.0.3 and 5.9.2 declarations. This is not a registry
release, deployment, production adoption, cancellation qualification, M3 or
Strata 1.0 certification.

## Public contract

- `StrataAnalogHttpError(status, code, message?, options?)` accepts statuses
  `400`, `404`, `409`, `422`, `429` and `503`. Codes match
  `^[a-z][a-z0-9_]{0,63}$`. Message and `cause` remain server-side diagnostic
  data.
- The route boundary translates the error to `{ "error": "<code>" }` with
  JSON UTF-8 content type and `Cache-Control: no-store`. It does not expose the
  message, cause, stack, custom details or validation issues.
- Translation occurs only after the request's single cleanup scope succeeds.
  Cleanup errors, including `AggregateError`, retain failure precedence and
  are not turned into a client response.
- `jsonResponse(value, init?)` serializes once into a native `Response`,
  defaults to status 200, preserves caller headers (including multiple
  `Set-Cookie` values), and supplies JSON UTF-8 content type only when absent.
  Native Response validation rejects invalid status/body combinations.
- `noContent(init?)` returns a bodyless 204 while preserving supplied headers
  and omitting content type.
- Existing guards still run before interceptors and controller construction;
  interceptors retain registration-order entry/reverse unwind; validation
  errors retain their existing safe 400/413/415 responses. Expected app errors
  thrown by handlers or interceptors follow the same cleanup-first rule.

## Qualification evidence

The fixture routes cover 401 and 403 guard decisions; Standard Schema create
and patch bodies; 404, 409 and 422 application failures; 201 JSON with caller
headers; and 204 deletion. A deterministic 24-request mixed matrix checks
isolation, cleanup, response codes and absence of private canary values.

The Analog Node fixture tuple is Node 22.23.1, Angular core/compiler 22.1.7,
`@angular/build` 22.1.8, Analog platform and Angular Vite plugins 2.7.2,
Analog Router 2.8.1, Nitro 2.13.4, H3 1.15.11, Vite 8.3.0 and TypeScript
6.0.3. The external full-stack packed consumer additionally passed with
Angular 22.2.3, TypeScript 6.0.3 / 5.9.2 and Wrangler 4.135.0. These are
installed fixture tuples, not broad support-range claims.

The final local checks recorded for this increment:

- `pnpm --filter @strata-sc/analog test`: 118 tests passed.
- `pnpm --filter @strata-sc/analog typecheck`: passed.
- `pnpm test:analog`: 112 checks passed across real Analog Node production and
  development servers.
- `pnpm test:server-components:cloudflare`: passed on local Wrangler/workerd;
  no Cloudflare account, secrets or deployment were used.
- `pnpm test:full-stack-package-consumer`: packed tarballs passed API behavior
  checks on Node and workerd; strict external declaration checks passed under
  TypeScript 6.0.3 and 5.9.2.

The local qualification completed with `CI=true pnpm install --frozen-lockfile`,
`pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
`pnpm format:check`. `pnpm test` includes the release unit suite (28 checks)
and performance-tool suite (163 checks). The Analog integration, package
consumer, packed Angular DI, packed full-stack, packed Server Components,
Server Components graph/navigation/defer/server-only/security/request-context/
authorization/failures/SSR-response/dev, local Cloudflare, website dogfood and
Relay dogfood commands all passed. `pnpm test:full-stack-deployed-cloudflare`
also passed its source-packed Cloudflare Pages build and local workerd rehearsal;
its output confirmed `REAL DEPLOYMENT: NOT RUN`. The site E2E was first invoked with default
port 3000, where Playwright reused an unrelated pre-existing Node server and
both tests failed against its stale content. Port 3000 was left untouched; a
fresh Node production build was started on port 4317 and
`STRATA_WWW_BASE_URL=http://127.0.0.1:4317 pnpm --filter @strata-sc/www test:e2e`
passed both tests. `pnpm www:build:cloudflare` passed. Entwine 0.5.1 context
(schema 0.4), `check` (57 documents, 257 links) and `build` passed; generated
documentation output is ignored and is not part of the change.

`pnpm changeset status` reports one minor bump for `@strata-sc/analog`, from
0.4.0 to 0.5.0. `pnpm release:packages:dry-run` packed and inspected the
registry-eligible packages successfully, but the current 0.4.0 versions were
already on npm and therefore skipped. Its non-fatal npm identity preflight
reported E401; it did not attempt publication. The current release workflow
will open the version PR after this implementation PR merges. No npm version
manifest was edited by hand and nothing was published.

Changeset policy is one minor entry for `@strata-sc/analog`; source package
version metadata remains at the current release until the normal Changesets
release process.

## Cancellation investigation

Cancellation was investigated against the pinned adapter path. The public
`StrataAnalogRequest` does not expose a signal. On Node, the pinned H3/Nitro
adapter constructs a synthetic Web Request without the incoming socket abort
signal. In local workerd, enabling Cloudflare's documented request-signal flag
still did not carry the incoming native Request signal through the pinned
Nitro/H3 event to Strata. No cancellation API is added on top of an absent or
unreliable signal. The Cloudflare platform documentation describes the native
capability, but does not establish propagation through this adapter:
[Cloudflare request cancellation](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/).

**Cancellation verdict: NO-GO / not available through the qualified adapter
path.** Cleanup still runs when an invocation settles normally or by error;
this evidence does not establish cleanup on client disconnect, response-stream
completion, worker termination or cancellation. Revisit after Nitro/H3 exposes
a stable request signal to the adapter, then test Node socket abort and
Cloudflare workerd abort end to end.

| Runtime path                   | Observed adapter boundary                                                                                                                                             | Verdict |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Nitro `node-server` production | Pinned H3 supplies a Web Request synthesized from the Node request; its `signal` does not represent incoming socket disconnect.                                       | NO-GO   |
| Analog development             | Uses the same H3/Nitro event adapter and no reliable transport signal is present on `StrataAnalogRequest`.                                                            | NO-GO   |
| Cloudflare Pages local workerd | Even with Cloudflare's `enable_request_signal` compatibility flag, the native incoming Request signal was not propagated through pinned Nitro/H3 to the Strata event. | NO-GO   |

## Limits and next milestone

The inventory store, principal tokens and authorization are deliberately
fixture-owned. The example does not provide sessions, credential verification,
CSRF policy, tenant isolation, durable storage, production observability or a
service-wide error taxonomy. The qualification covers the current pinned
Analog/Nitro/H3 tuple and local runtimes only. Hosted Actions will be observed
through the PR; no site or package deployment/publication is part of this work.
