# Analog request-scoped HTTP interceptors

## Scope and API

Starting main: `8417d60e040190a6a68c91a96f8380db934908bf`.

`@strata-sc/analog` adds `StrataAnalogInterceptor`,
`StrataAnalogInterceptorContext` and `StrataAnalogNext`, configured through the
optional `RegisterControllersOptions.interceptors` array. The array is checked
before route registration, copied and frozen. Each registration owns its own
snapshot. The context exposes the existing request, route information and
request-local `onCleanup` callback; it does not expose Nitro/H3 internals.

## Execution contract

Guards run sequentially before any interceptor. A denial remains the existing
safe 401/403 response, runs cleanup, and skips interceptors, factory and
handler. When allowed, interceptors run onion-style: A before B, then factory
and handler, then B after A. They share the guard/factory request cleanup
scope. Cleanup runs once, LIFO and awaited after interceptor unwinding.

An interceptor that returns normally must invoke `next()` once and wait for
downstream settlement. Missing, repeated or concurrent calls are configuration
errors; calling next after settlement is rejected. Interceptors may throw
before calling next, observe/rethrow downstream errors, or transform returned
data. They cannot short-circuit with a cached result. A caught application
error that is replaced is consumer-owned policy.

Values flow directly to Nitro. The adapter does not add serialization or wrap
values in `Response`. A pass-through native `Response` is left intact; a
consumer-created replacement follows Web API body and header ownership rules.
Do not consume response bodies for logging. Expected validation errors remain
safe 400/413/415 responses when rethrown. Unexpected errors are not converted
to client errors, and private errors are not placed in public responses.

## Evidence and limitations

The focused Analog package suite passes (109 tests), including onion ordering,
guard precedence, transformed data, native `Response` pass-through, exact
guard/interceptor/factory LIFO cleanup ordering, malformed/missing/repeated/
concurrent `next()` handling, and draining detached downstream work before
cleanup. Package typecheck passes.

`pnpm test:analog` passes 86/86 checks on Analog dev and Nitro Node production.
The greeting fixture proves the response transformation, and guarded plus
Standard Schema validation routes use a pass-through interceptor; existing
24-request validation and authorization checks pass. The separate Cloudflare
Pages/workerd qualification passes with an intercepted and transformed greeting
and a guarded route. The packed consumer verifies interceptor declarations and
runtime with TypeScript 5.9.2; the full-stack packed consumer passes strict
TypeScript 6.0.3/5.9.2 checks and Node/local-workerd runtime checks with public
and guarded routes wrapped by an interceptor.

The repository build, lint, typecheck, unit/release/performance-tools gates
pass. Server Component navigation/defer/server-only/security/request-context/
failure/SSR-response/authorization/dev fixtures pass; both Cloudflare
qualification and the full-stack source-packed workerd rehearsal pass. Packed
Server Component and full-stack consumers, www/Relay Server Component dogfood,
and the Cloudflare site build pass. Entwine 0.5.1 check and build pass. The
standalone `pnpm --filter @strata-sc/www test:e2e` currently fails both tests:
the page never sets `html[data-app-ready="true"]`; no `apps/www` files are
changed by this branch, and the `test:www:server-components` Playwright suite
passes. The earlier Cloudflare run also caught and fixed a stale expected
greeting value after the transformation was added; the rerun passes. GitHub
Actions results are pending until the branch is pushed. No deployed Cloudflare
project or package publication was used. Do not treat fixture evidence as
production qualification.

Interceptors do not provide authentication, production tracing, arbitrary
short-circuiting, cancellation semantics or a full response-stream lifecycle.
M3, real application adoption and Strata 1.0 remain unqualified.
