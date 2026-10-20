# Angular DI with Analog guards, interceptors and validation

Qualification for the existing consumer-owned Angular controller lifecycle on
Node. Starting synchronized `main` SHA: `eb1d17a81283d57569e9dc1b4712dea2623f6fd6`.
This extends the SPEC-003 fixture; it adds no DI container and changes no
public package API.

## Runtime tuple and reused fixture

The lockfile tuple exercised by `pnpm test:analog` is Node 22.23.1, Angular
core/common/compiler 22.1.7, Angular platform-browser 22.2.1,
platform-server/router 22.2.2, Analog 2.7.2, Nitro 2.13.4, H3 1.15.11,
TypeScript 6.0.3, Vite 8.3.0, Wrangler 4.135.0 and workerd compatibility date
2026-09-21.

`CatalogController`, `CatalogService`, `RequestIdentity`, `RequestAudit`,
`STRATA_REQUEST`, the consumer-owned application injector, the existing
`controllerFactory` and its `onCleanup` disposal are reused. Its original
SPEC-003 routes and rendezvous checks remain intact. The Angular request
injector is a child of the fixture's application injector; it is separate from
Angular SSR and Analog server-function injectors.

## HTTP composition

Only `/api/strata/angular-di/protected/**` uses the new synthetic policy. The
existing SPEC-003 paths remain public and keep their previous response shape.
The guard recognizes only fixture-owned opaque credentials mapped to `alpha`
and `beta`, checks the requested product owner, and associates the verified
principal with that exact `StrataAnalogRequest`. A raw identity header or query
parameter is not used. Missing/invalid credentials return 401, an authenticated
wrong owner returns 403, and denials run guard cleanup without entering an
interceptor or creating an Angular request injector.

Two fixture interceptors run through the existing `StrataAnalogInterceptor`
contract. The timing observer and outcome mapper enter in configuration order
and unwind in reverse order. They each register cleanup in the shared
`CleanupScope`. The response mapping preserves native `Response` objects and
adds a trace only to plain JSON objects on the composed routes. Downstream
errors are rethrown so Strata can preserve input-error translation and cleanup
precedence; fixture errors use generic messages. Checks cover a pre-next
interceptor failure, an after-next interceptor failure, downstream sync/async
throws, and rethrowing a downstream failure.

GET validates numeric route params and transforms a query tag to uppercase
through Standard Schema. POST validates params and a JSON body. Invalid schema,
malformed JSON, oversized JSON and unsupported media type return the existing
safe 400/413/415 responses. They do not expose schema issues or private
fixture values and destroy any request injector already created. A native
`Response` from the handler is preserved without a second JSON serialization.

## Injector lifetime, overrides and cleanup

Each authorized invocation creates one Angular `EnvironmentInjector`, resolves
`CatalogController` synchronously inside `runInInjectionContext`, and registers
destruction through `onCleanup`. The application-scoped `CatalogService` stays
at one instance. `RequestIdentity` and `RequestAudit` share one request-local
instance; the identity retains the active request and verified principal.
`ngOnDestroy` and `DestroyRef` run on success and the tested failure paths.
Controller methods access captured dependencies after `await`; the injector
remains alive through both interceptor unwind callbacks.

One request can override a synthetic `REQUEST_CONFIGURATION` child provider.
Its sibling inherits the unchanged application value. No request-specific
provider is installed in the root injector.

Factory failure creates no request injector. Provider-factory and controller
construction failures destroy the injector they created. Successful, denied,
validation-failure, handler-failure, interceptor-failure and multiple-cleanup
failure cases run through the existing `CleanupScope`. Instrumented LIFO checks
observe injector disposal, outcome cleanup, timing cleanup and guard cleanup
in that order. Cleanup failures remain 500 failures and are not converted into
client 400/401/403 responses.

## Concurrent isolation

The runner sends 24 mixed requests in three concurrent batches of eight. The
first batch contains eight authorized requests held at an explicit eight-party
rendezvous. The second mixes denials and invalid schema input. The third mixes
valid credentials with asynchronous handler and interceptor failures. It
asserts unique identities for the rendezvous requests, correct principal to
request association, no DI construction on denial, stable application service
identity, safe response bodies, zero cleanup-order violations, and zero live
request injectors after each batch. The fixture's lifetime counters also
assert that every created injector is eventually destroyed.

## Results

`pnpm test:analog` runs the real Analog development server and Nitro
`node-server` production output. The final clean run passed 110/110 checks
across both arms; the baseline, existing route checks and every composition
scenario passed in production and development:

| Qualification                                       | Development | Production |
| --------------------------------------------------- | ----------- | ---------- |
| Existing SPEC-003 routes and checks                 | GO          | GO         |
| Guarded Angular DI success and denial               | GO          | GO         |
| Interceptor order and error behavior                | GO          | GO         |
| Standard Schema params/query/body and safe failures | GO          | GO         |
| Provider identity, overrides and destruction        | GO          | GO         |
| 24-request mixed isolation matrix                   | GO          | GO         |

The runner sends independent synthetic requests with `connection: close` to
avoid reusing an idle Node HTTP connection between larger fixture scenarios.
The matrix itself uses no retries. Its first eight-request batch completes
only after the deterministic rendezvous has all eight participants.

The exact runner output is also retained in the generated
[Analog integration baseline](analog-integration-baseline.md).

## Workerd and external consumers

The known local workerd limitation remains a NO-GO: Angular JIT attempts
dynamic code generation and workerd throws `EvalError: Code generation from
strings disallowed for this context`. No eval flag, `nodejs_compat` workaround,
Angular patch or Worker support claim is part of this change. The existing
workerd characterization must continue to show no request injector is created
on that failure and unrelated Worker routes remain available.

The packed core/Analog and full-stack consumers do not exercise this
Angular-backed route. Packed Angular DI therefore remains NOT QUALIFIED. No
package was published and no deployment was attempted. No Changeset is
warranted because no production package API or implementation changed.

## Limitations and next increment

This is a fixture qualification, not real-application security certification.
It does not establish shared SSR/controller or server-function DI, production
authentication, Worker DI, cancellation/abort behavior, Angular root shutdown
with active requests, packed Angular DI consumer support, or Strata 1.0
readiness.

Next increment: prove the existing Angular component compiler and strict
server/client graph boundary in the minimal Analog fixture, retaining the
workerd JIT NO-GO.
