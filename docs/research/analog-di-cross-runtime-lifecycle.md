# Analog Angular DI lifecycle across runtimes

Qualification record for the existing SPEC-003 consumer-owned Angular
controller factory. Starting main SHA: `289032f2898cd15b3fb67cf35a45e1ba9ab4afac`.
The synchronized feature branch is `test/analog-di-lifecycle-workerd`.

## Scope and existing contract

SPEC-003 already established the Node contract using the public Angular APIs
`createApplication`, `createEnvironmentInjector`, `runInInjectionContext`,
`EnvironmentInjector`, `DestroyRef` and `InjectionToken`, together with
Strata's existing `controllerFactory` and `onCleanup`. This work reuses that
fixture and does not add a Strata DI container or Angular dependency to
`@strata-sc/analog`.

The consumer owns a separate application injector for its Nitro plugin. The
factory creates one child environment injector for each controller
invocation, resolves the controller synchronously inside
`runInInjectionContext`, and registers child destruction with `onCleanup`.
Captured dependencies remain usable after `await`; calling `inject()` in a
handler body fails with `NG0203`. The controller injector is not Analog SSR's
or its server-function injector.

Resolved workspace fixture tuple observed during this run: Node 22.23.1,
Angular core/common/compiler 22.1.7, Angular platform-browser 22.2.1,
platform-server/router 22.2.2, Analog packages 2.7.2, Nitro 2.13.4, H3
1.15.11, TypeScript 6.0.3, Vite 8.3.0, Wrangler 4.135.0, workerd
compatibility date 2026-09-21. `pnpm test:analog`
reported 86/86 checks passed. Its production and dev cases proved a shared
application `CatalogService`, distinct request identities at a two-request
rendezvous, same-request sharing with `RequestAudit`, `STRATA_REQUEST`
identity, `DestroyRef` and `ngOnDestroy` cleanup, and cleanup after sync and
async handler failures. The lone-rendezvous negative control did not meet.

## Cross-runtime results

| Gate                                      | Result                        | Evidence                                                                                 |
| ----------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Analog development server                 | GO for the SPEC-003 scenarios | `pnpm test:analog`, dev scenarios passed                                                 |
| Nitro `node-server` production            | GO for the SPEC-003 scenarios | `pnpm test:analog`, production scenarios passed                                          |
| Cloudflare Pages build and local workerd  | NO-GO for Angular DI          | `pnpm test:server-components:cloudflare`, real fixture Worker and Wrangler local runtime |
| External packed consumer using Angular DI | NOT QUALIFIED                 | Existing consumer checks do not install and exercise this DI fixture                     |

The Cloudflare build resolves `cloudflare-pages`, and the same fixture runs
under local Wrangler/workerd without `nodejs_compat`. The Worker graph contains
`@angular/compiler`; the browser graph does not. A request to the DI route
returns 500 before the controller factory creates a child injector. Wrangler
reports `EvalError: Code generation from strings disallowed for this context`
from Angular's `JitEvaluator` while compiling the `RequestIdentity` injectable
factory. Before and after stats both show zero request injectors created,
zero alive, and zero service/controller destruction callbacks. The Worker
continues serving other routes. This is an Angular JIT/runtime limitation, not
a missing cleanup callback or a Nitro bundling failure. Retaining the JIT
compiler in the Worker bundle does not make dynamic code generation available.

No supported fix was found within the existing public APIs. Do not enable
`nodejs_compat`, introduce dynamic evaluation, or describe the result as a
portable Worker recipe. Consumer-owned Angular DI on local workerd is NO-GO
for this tuple and configuration.

## Composition coverage and gaps

The original run kept guards, interceptors, Standard Schema validation and the
DI controller separate, so it did not qualify their composition. That specific
Node gap is superseded by the [Angular DI HTTP composition report](analog-di-http-composition.md):
the existing controller now runs behind the existing consumer-owned guard and
interceptor contracts, uses Standard Schema inputs, and passes a 24-request
mixed isolation matrix in real Analog dev and Nitro Node production.

The new report also covers request provider overrides, factory/provider/
constructor failures and cleanup-error precedence. Active request behavior
during Nitro shutdown and abort/cancellation are still not covered. Strata's
cleanup scope remains invocation-scoped and awaited; no abort propagation
contract is claimed. A startup failure while
creating the consumer application injector prevents the plugin from
registering its routes. Shutdown with active requests has not been tested;
the fixture's Nitro close hook destroys the root application when invoked,
with no tested drain or cancellation guarantee.

## Bundle and confidentiality measurements

The Cloudflare qualification measured the whole current fixture Worker
reachable graph at 2,444,654 JavaScript bytes (674,922 gzip bytes); this
fixture includes unrelated Server Component and application code, so it is
not the Angular DI delta. The preceding SPEC-003 Node experiment measured
4,492 KB without its DI plugin and 7,716 KB with it; that old comparison was
not repeated at this starting main. No same-revision plugin-off/on Worker
comparison or compressed standalone Worker artifact measurement was run.

The current Node runner's marker checks passed: the DI marker is in the server
output and absent from client, public, and SSR outputs. The current workerd
check confirms `@angular/compiler` is absent from browser output. It does not
scan private DI canaries in source maps, SSR responses, or API response bodies;
those confidentiality conditions are not qualified here.

## Package and CI status

No runtime package changed, so no Changeset is warranted. No package was
published and no deployment was attempted. `pnpm test:analog` passed 86/86
checks, and `pnpm test:server-components:cloudflare` passed with the expected
workerd DI failure characterization. The requested
`pnpm test:full-stack-deployed-cloudflare` command was blocked by automatic
review because it can deploy when credentials are present; it was not retried.
The separate packed full-stack consumer ran its local workerd rehearsal
successfully, without deployment. The full-stack packed consumer and the
Server Component packed consumer passed, but neither constructs an Angular DI
controller. Repository build, lint, typecheck, tests, format check, release
tests, performance-tool tests, the requested Node/workerd integration suite,
website E2E against a fresh server on port 43791, and `www:build:cloudflare`
passed. The first default website E2E attempt reused a server on port 3000 and
failed its readiness/content assertions; with the fresh server and
`STRATA_WWW_BASE_URL`, both tests passed. Entwine 0.5.1 check and build passed.
GitHub Actions were not inspected remotely, and no PR was opened as part of
this report.

## Verdicts

- Consumer-owned Angular DI on Node: **GO**, for the SPEC-003 scenarios only.
- Consumer-owned Angular DI on local workerd: **NO-GO**.
- Request provider isolation: **GO** for the SPEC-003 rendezvous and the 24-request mixed Node matrix.
- Application provider lifetime: **GO** for reuse across tested requests; root injector destruction on Nitro shutdown is not directly asserted.
- Provider override: **GO** for the tested request-local synthetic override; broader consumer patterns remain unqualified.
- Cleanup and error precedence: **GO** for tested success, denial, input, factory/provider/controller, handler, interceptor and cleanup failures on Node.
- Guard, interceptor and validation composition with Angular DI: **GO** on the tested Node fixture paths.
- Server-only bundle confidentiality: **PARTIAL**; marker scans pass, private canary/source-map/API/SSR tests are missing.
- External packed consumer: **NOT QUALIFIED**.
- Shared Angular SSR/controller injector: **NOT QUALIFIED**.
- Shared Analog server-function injector: **NOT QUALIFIED**.
- Real Cloudflare deployment: **NOT RUN**.
- Abort/cancellation lifecycle: **NOT QUALIFIED**.
- Real production application: **NOT QUALIFIED**.
- Strata 1.0: **NOT YET QUALIFIED**.

## Next increment

Qualify the Angular component compiler and strict server/client graph boundary
in the minimal Analog fixture. Keep the Worker result NO-GO; do not implement
this next increment here.
