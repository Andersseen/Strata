# Analog request-scoped guards

## Baseline and scope

Starting main: `b1f07b5aad760d0fe811ec7c877f8f0e1c9b4dba` (the local `main` and `origin/main` refs matched this SHA). This is one additive, experimental `@strata-sc/analog` increment. No core dependency or authentication provider is added.

## Public contract

`registerControllers(router, controllers, { guards })` snapshots the guard array at registration. Each `StrataAnalogGuard` receives a request-local `StrataAnalogGuardContext`: the `StrataAnalogRequest`, immutable route info (`method` is the registered uppercase HTTP method; `path` is the final Nitro route pattern; `controller` is the controller class name; `handler` is the decorated method name), and the invocation's existing `onCleanup` callback. It receives no H3 event, Nitro internals, constructor, or metadata storage.

A guard returns exactly `{ allow: true }` or `{ allow: false, status: 401 | 403 }`. Checks run sequentially. An invalid value is a `StrataAnalogConfigurationError`; it cannot authorize. Exceptions and rejected promises remain application errors. On allow, the next guard runs; only after every guard allows does Strata invoke and verify the controller factory, then call the handler.

The execution order is route match, request snapshot, one cleanup scope, sequential guards, controller factory, instance check, handler, awaited LIFO cleanup, then response settlement/error propagation. Denials stop the chain and skip factory, construction and handler. Denials return generic `{"error":"unauthorized"}` or `{"error":"forbidden"}`, with JSON UTF-8 content type and `Cache-Control: no-store`; details are never echoed. Cleanup failure prevents a successful denial response and retains existing cleanup error precedence.

Registration validates guard arrays and entries before router mutation, along with existing eager controller/route validation. Empty/no guards preserve the old lifecycle. Guard configuration is copied and frozen per registration.

## Interoperability and limitations

Guards use the existing request's Standard Schema methods. For example, `await request.validateParams(schema)` can fail with the existing safe 400 contract before controller creation. No guard automatically reads a body. `readValidatedJson` must remain the first body reader to retain its byte bound; a prior raw read causes the existing configuration error.

Authentication and authorization policy belong to the consuming app. Strata does not verify credentials, manage sessions, implement RBAC/ABAC, CSRF, global guards, or interceptors. Route metadata is descriptive and stable at runtime, but renaming a controller or handler changes its string identifier. This work does not certify production authentication, tenant isolation, real-app adoption, or Strata 1.0.

## Verification record

The Analog package typecheck passes, and its unit suite passes (104 tests). `pnpm test:analog` passes 86/86 checks on the real Analog production server and development server. That fixture runs 24 overlapping requests with two opaque synthetic principals, missing/invalid credentials, public reads, allowed owner operations, denied cross-owner operations, and denial non-disclosure. Existing Standard Schema validation checks, native Nitro coexistence, controller lifecycle and dev routes pass in the same run. The packed standalone consumer passes strict TypeScript 5.9 declaration checks and runs 24 overlapping guard requests on a real Node HTTP server. `pnpm test:full-stack-package-consumer` passes its packed Node and local Cloudflare Pages/workerd checks; in each runtime its synthetic authorization gate passes missing/invalid token, public read, allowed owner access, forbidden cross-owner access, safe responses, and 24 overlaps alongside Server Components. Guard API declarations are also included in that fixture's TypeScript 6 and 5.9 checks. Unit and packed Node controls assert denied handlers do not construct controllers. `pnpm test:full-stack-deployed-cloudflare` also passes its Cloudflare build and local workerd rehearsal (779 requests, zero anomalies); `REAL DEPLOYMENT: NOT RUN`. The local CI-equivalent suite and Entwine checks pass; hosted Actions remain pending until a pull request runs. The broader CI feature matrix does not yet cover every guard failure/cleanup negative control through real HTTP. Do not interpret this report as a completed M3 gate.

## Verification failures and corrections

All observed failures below were resolved before this report. They were environment restrictions or fixture/harness mistakes, not remaining product failures.

| Command                                                      | Observed failure                                                                                                                                      | Corrective action and final status                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:analog` (sandboxed)                               | Node could not bind `127.0.0.1` (`EPERM`). The authorized rerun exposed one cross-owner fixture case using the wrong resource ID.                     | Reran with network binding available, corrected the fixture ID, and reran the complete command: **86/86 checks passed**.                                                                           |
| `pnpm test:package-consumer` (initial attempts)              | Fixture POSTs used incomplete/prefix-duplicated route paths and returned 404.                                                                         | Corrected consumer route construction; final packed TS 5.9 and Node HTTP run passed.                                                                                                               |
| `pnpm test:full-stack-package-consumer` (initial attempts)   | Harness called `.text()` on a custom response without that method; after normalization, a POST used the wrong root path and the status matrix failed. | Normalized checks to Fetch `Response` and fixed the POST target; final TS 6/5.9, Node, Cloudflare Pages build and local workerd run passed.                                                        |
| `pnpm test:full-stack-deployed-cloudflare` (earlier attempt) | The local verification harness initially used an incorrect guard URL.                                                                                 | Corrected the URL and reran with deployment flags and Cloudflare credentials unset: build and local workerd rehearsal passed; no remote deployment ran.                                            |
| `pnpm lint` (first run)                                      | New validator/type code triggered unsafe-index/spread and type errors; a test cleanup callback type was too narrow.                                   | Tightened runtime narrowing and callback typing; final lint passed.                                                                                                                                |
| `pnpm --filter @strata-sc/analog typecheck` (first run)      | TypeScript TS4111 rejected direct reads through an index signature in the validator.                                                                  | Used bracket access and explicit narrowing; final typecheck passed.                                                                                                                                |
| `pnpm test` (sandboxed)                                      | Existing performance tests could not bind `127.0.0.1` (`EPERM`).                                                                                      | Reran with network binding available; full suite passed (163 tests).                                                                                                                               |
| `pnpm --filter @strata-sc/www test:e2e` (first run)          | The app readiness check failed because an unrelated user-owned process occupied port 3000.                                                            | Left that process untouched, started this task's built server on port 3001, and reran using `STRATA_WWW_BASE_URL=http://127.0.0.1:3001`; **2/2 passed**. Stopped only the task's server afterward. |

`pnpm exec prettier --check .` passed during iteration. The exact `pnpm format:check` script is run in the final local verification pass.

## Alternatives

The API is registration-level configuration rather than decorators or mutable global policy. Route metadata enables per-route policy selection without exposing constructors or reflection storage. A discriminated decision union avoids truthy/falsy authorization. Authentication packages, middleware frameworks and automatic principal injection were excluded to keep identity and policy consumer-owned.

## Remaining M3 work and next increment

Hosted workflow evidence remains outstanding until the pull request runs. Exactly one recommended next increment after this work: define and implement Analog's minimal HTTP interceptor execution contract with explicit order, response handling, errors, logging and cleanup. Do not include it in this increment.
