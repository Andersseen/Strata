# Current implementation audit

Inspected on 2026-09-17 at `9d2635e` (`main`). Initial working tree was clean.
Scope: all tracked source, tests, manifests, build/test/compiler configuration, CI, Changesets,
root documentation and relevant history; dependency resolution inspected in `pnpm-lock.yaml`.
There were no existing `docs/`, application fixtures or package-local instructions in this checkout.

## History

| Commit                         | Actual increment                                                 |
| ------------------------------ | ---------------------------------------------------------------- |
| `fb5038c`                      | OSS workspace/tooling foundation                                 |
| `80341ea`, merged by `61d0959` | Core controller/GET metadata; TypeScript decorator pre-transform |
| `b899c59`, merged by `9d2635e` | Real H3 v2 adapter and integration tests                         |

The next slice must not recreate H3 execution: it already exists.

## Implemented contracts

| Area                 | Evidence and limitations                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core exports         | [Public barrel](../packages/core/src/index.ts): `Controller`, `Get`, `getControllerDefinition`, definition types, `HttpMethod` and `STRATA_VERSION`                                             |
| Metadata             | Standard decorator `context.metadata`, private symbol keys, guarded `Symbol.metadata` initialization; frozen route records, definition and route array. No H3 or Angular dependency.            |
| Paths                | Missing/empty paths become `/`; leading slash added, repeated slashes collapsed, trailing slash removed. `HttpMethod` is only `"GET"`.                                                          |
| Adapter exports      | [Public barrel](../packages/h3/src/index.ts): `registerControllers`, `ControllerClass`, `StrataH3ConfigurationError`                                                                            |
| Execution            | Reads core's public definition, joins paths, calls `app.on`, returns the original H3 instance. Native H3 routes coexist. Sync/async results pass to H3.                                         |
| Lifecycle            | One no-argument constructor invocation per controller entry per registration call; instance reused by its routes and requests. Methods receive **no request argument**. No DI or request scope. |
| Configuration errors | Missing controller metadata and non-callable handlers throw during registration. This is not an atomic registration transaction.                                                                |
| Runtime dependency   | Manifest `h3: ^2.0.1-rc.1`; lockfile resolves **2.0.1-rc.32**. H3 and core are externalized in adapter build.                                                                                   |
| Distribution         | ESM-only, `dist` exports, declarations/maps; both versions `0.0.0`. README says unpublished; npm publication was not independently verified. Two pending minor Changesets.                      |

The dynamic-route test proves matching `/users/123`; its handler returns a fixed object. It does
**not** prove parameter extraction. No request, body, query or header API is implemented.

## Toolchain and checks

Repository pins pnpm 10.30.1, TypeScript 6.0.3, Vite 8.3.0, Vitest 5.0.1; lockfile resolves
Rolldown 1.2.8. Manifests declare Node `>=22`; CI selects Node 22 and runs lint, typecheck, tests
and build. That configuration is not evidence of a successful remote CI run or all Node versions.

Both packages contain a private `vite-plugin-standard-decorators.ts`. It invokes TypeScript
`transpileModule` with ES2023/ESNext before Vite, excludes dependencies and declaration files,
and only matches IDs ending in `.ts`. It is used by their Vite/Vitest configurations and is not
exported or shipped as a consumer tool. `transpileModule` does not replace type checking.

Local check in this audit: `pnpm exec vitest run` on Node **22.23.0** passed **34 tests in 6 files**
(22 core tests, 12 adapter tests). Existing installed dependencies and built core output were used;
this was not a clean build, tarball installation or deployment test. No production source was
changed to obtain this result.

## Gaps and review findings

- No Angular/Analog/Nitro dependency, DI integration, non-GET decorators, request API, validation,
  guards/interceptors, logging contract, component compiler, navigation protocol or deployment fixture.
- No packaged-consumer tests, browser/e2e tests, browser bundle assertions or Cloudflare execution.
- Metadata access uses inherited property lookup; route accumulation may reuse an inherited array.
  Undecorated subclasses, decorated siblings, overrides and redecorated subclasses need explicit
  semantics and regression tests. Independent-class tests do not cover inheritance.
- `Get` rejects symbol names but does not explicitly reject static/private methods. The adapter's
  instance lookup catches some invalid shapes later. Supported member shapes need a contract.
- Duplicate routes, registration across repeated calls, partial failure and constructor failures are
  not specified. Do not infer atomicity, conflict handling or stable lifecycle from today's implementation.
- Handler exceptions, `Response`/stream passthrough and cancellation lack dedicated Strata tests.
- The README previously promised parameter decorators and future documentation; CONTRIBUTING still
  described a featureless foundation. This documentation pass aligns those entry points.

These are inputs to M1/M3, not permission for Astra to implement fixes. The selected next spec
establishes a consumer baseline first; it does not declare the remaining primitive contracts stable.
