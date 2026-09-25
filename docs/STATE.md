# Current implementation audit

## Reconciliation 2026-09-24

Inspected at `c671ba4` (`main`, merge of PR #19) plus the SPEC-003 branch. The sections after this
one are the 2026-09-17 audit at `f258fc3`. They are kept as recorded, and this section supersedes
their current-state claims where the two differ. Work now runs on two tracks with independent gates:

| Track                                             | Scope                                                                 | State                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 consumer qualification                         | `@strata/h3` (H3 v2) packed consumers, strict declarations; M1        | SPEC-001 and SPEC-002 executed. **Upstream-blocked**: H3's `HTTPError.isError` lib assumption and its crossws import graph fail strict TS 6.0.3 consumers; no published closure qualifies. `pnpm test:consumer` stays failing on AC2 by design. Unchanged by later work.              |
| Analog integration / Server Component feasibility | `@strata/analog` (Nitro 2 / H3 v1) inside a real Analog 2.7.2 app; M2 | Executed and passing in dev and production ([baseline](research/analog-integration-baseline.md)). `@strata/analog` exposes no H3 v2 (or v1) declarations, so the H3 type blocker does not apply to it. Packed-consumer qualification of `@strata/analog` itself has **not** been run. |

Analog track increments since the 2026-09-17 audit:

| PR / spec | Increment                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #7        | Analog integration baseline fixture and `pnpm test:analog`                                                                                                                   |
| #8        | `@strata/analog`: `registerControllers(nitroApp.router, …)` from a Nitro plugin; depends only on `@strata/core`                                                              |
| #17       | Provisional `StrataAnalogRequest` (method, path, URL, headers, params, query, context snapshot, lazy body readers); Nitro/H3 event not exposed                               |
| #18       | Controllers are **request-scoped**: no instance at registration, one per request through experimental `controllerFactory` (default `new Controller()`)                       |
| #19       | Experimental `onCleanup` on the factory context: LIFO, awaited, exactly once, on success and every failure path, before the route handler settles                            |
| SPEC-003  | Angular DI feasibility: **CONDITIONAL GO** through consumer-owned Angular injectors on the existing seam; no Strata API change ([report](research/analog-di-feasibility.md)) |

Current lifecycle facts:

- `@strata/h3` still creates one controller instance per controller at registration and shares it
  across requests. That instance is never a safe place for request state.
- `@strata/analog` creates a controller per request and provides no injector. With the consumer glue
  measured in SPEC-003, controllers resolve application- and request-scoped Angular services with
  `inject()` at construction. Overlapping requests are isolated (barrier-proven), and request
  injectors are destroyed on success, throw and rejection. The application injector is separate
  from Analog's SSR and server-function injectors (no supported seam reaches those), and the Nitro
  bundle then needs `@angular/compiler` declared in `nitro.moduleSideEffects`.
- Not yet verified on the Analog track: Workers, abort/timeout cleanup, streamed-body lifetimes,
  packed `@strata/analog` consumers, non-GET methods.

The first gap bullet of the 2026-09-17 audit below ("No Angular/Analog/Nitro dependency, DI
integration … request API") is superseded by the table above. Its other bullets still stand.

## Audit of 2026-09-17

Inspected on 2026-09-17 at `f258fc3` (`main`, merge of SPEC-001 / PR #4). Initial working tree was clean.
Scope: all tracked source, tests, manifests, build/test/compiler configuration, CI, Changesets,
root documentation and relevant history; dependency resolution inspected in `pnpm-lock.yaml`.
Documentation, packed-consumer fixtures and qualification tooling now exist. No production package
files changed between `9d2635e` and this checkout.

## History

| Commit                         | Actual increment                                                 |
| ------------------------------ | ---------------------------------------------------------------- |
| `fb5038c`                      | OSS workspace/tooling foundation                                 |
| `80341ea`, merged by `61d0959` | Core controller/GET metadata; TypeScript decorator pre-transform |
| `b899c59`, merged by `9d2635e` | Real H3 v2 adapter and integration tests                         |
| `1929957`, merged by `a7fe88c` | Architecture/SDD documentation and SPEC-001                      |
| `f865fca`, merged by `f258fc3` | SPEC-001 tooling, executed evidence and consumer CI invocation   |

The next slice must not recreate H3 execution or packed-consumer tooling: both already exist.

## Implemented contracts

| Area                 | Evidence and limitations                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core exports         | [Public barrel](../packages/core/src/index.ts): `Controller`, `Get`, `getControllerDefinition`, definition types, `HttpMethod` and `STRATA_VERSION`                                                                                                                                                                                                             |
| Metadata             | Standard decorator `context.metadata`, private symbol keys, guarded `Symbol.metadata` initialization; frozen route records, definition and route array. No H3 or Angular dependency.                                                                                                                                                                            |
| Paths                | Missing/empty paths become `/`; leading slash added, repeated slashes collapsed, trailing slash removed. `HttpMethod` is only `"GET"`.                                                                                                                                                                                                                          |
| Adapter exports      | [Public barrel](../packages/h3/src/index.ts): `registerControllers`, `ControllerClass`, `StrataH3ConfigurationError`                                                                                                                                                                                                                                            |
| Execution            | Reads core's public definition, joins paths, calls `app.on`, returns the original H3 instance. Native H3 routes coexist. Sync/async results pass to H3.                                                                                                                                                                                                         |
| Lifecycle            | One no-argument constructor invocation per controller entry per registration call; instance reused by its routes and requests. Methods receive **no request argument**. No DI or request scope.                                                                                                                                                                 |
| Configuration errors | Missing controller metadata and non-callable handlers throw during registration. This is not an atomic registration transaction.                                                                                                                                                                                                                                |
| Runtime dependency   | Manifest `h3: ^2.0.1-rc.1`; lockfile resolves **2.0.1-rc.32**. H3 and core are externalized in adapter build.                                                                                                                                                                                                                                                   |
| Distribution         | ESM-only, `dist` exports, declarations/maps. Changesets versions: core/analog/h3 `0.1.0`. Only core and analog are published, by the manual `publish-packages.yml` under `next`, first publish pending ([ADR-004](adr/004-experimental-npm-distribution.md)); h3 is excluded. `pnpm test:package-consumer` qualifies the packed tarballs with TypeScript 5.9.2. |

The dynamic-route test proves matching `/users/123`; its handler returns a fixed object. It does
**not** prove parameter extraction. No request, body, query or header API is implemented.

## Toolchain and checks

Repository pins pnpm 10.30.1, TypeScript 6.0.3, Vite 8.3.0, Vitest 5.0.1; lockfile resolves
Rolldown 1.2.8. Manifests declare Node `>=22`; CI selects Node 22 and runs lint, typecheck, tests
and build, then `pnpm test:consumer`. That configuration does not certify all Node versions.
The [merge CI run](https://github.com/Andersseen/Strata/actions/runs/35225050803/job/105214360278)
failed at lint (23 unresolved-type errors in adapter source/tests); later steps, including consumer
qualification, were skipped. Public core exports target `dist`, which a fresh checkout has not built
before lint. This is a separate workspace bootstrap issue, not remote reproduction of AC2. Local
`pnpm lint` passes with existing build artifacts. SPEC-002 must make the qualification reachable
from a clean checkout without disabling rules or aliasing package source.

Both packages contain a private `vite-plugin-standard-decorators.ts`. It invokes TypeScript
`transpileModule` with ES2023/ESNext before Vite, excludes dependencies and declaration files,
and only matches IDs ending in `.ts`. It is used by their Vite/Vitest configurations and is not
exported or shipped as a consumer tool. `transpileModule` does not replace type checking.

Earlier pre-SPEC-001 local check: `pnpm exec vitest run` on Node **22.23.0** passed **34 tests in 6 files**
(22 core tests, 12 adapter tests). Existing installed dependencies and built core output were used;
this was not a clean build, tarball installation or deployment test. No production source was
changed to obtain this result.

## SPEC-001: executed, runtime proven, strict type qualification blocked

The [recorded run](research/consumer-compilation.md) used baseline `a7fe88c`, Node 22.23.0,
pnpm 10.30.1, TypeScript 6.0.3, Vite 8.3.0 and H3 2.0.1-rc.32. Its implementation was merged in
[PR #4](https://github.com/Andersseen/Strata/pull/4). Review confirms:

- `tests/consumer/fixture` and `tools/consumer` build/pack both packages, install them outside the
  workspace and use consumer-local tools and public imports. `workspace:*` becomes `0.0.0`; the
  fixture's local-tarball override yields one core copy. This does not prove registry publication.
- Consumer-authored standard decorators compile through `tsc`; emitted JS runs in plain Node.
  Vite SSR bundling of that JS also runs. Both exercise real in-process H3 requests: sync/async
  controller routes, instance binding and a native route. Public metadata and preservation of an
  existing `Symbol.metadata` pass. No listening server or deployment was tested.
- Strict consumer typecheck exits 2: H3's `HTTPError.isError` uses `static override` without the
  ambient `Error.isError` in the fixed lib set (TS4113); H3's root declarations import optional
  `crossws` types even for HTTP-only consumers (TS2307). No diagnostic in this run originates in
  Strata declarations. Strata nevertheless owns qualification of its exposed dependency contract.
- JS was emitted because `noEmitOnError` defaults to false. Runtime success does not make the
  typecheck clean. The consumer does not inherit the workspace's `skipLibCheck: true`.
- Direct stock Vite builds but retains standard decorator syntax; Node rejects it. The reference
  `tsc → JS → Vite → Node` path works. This proves a consumer compilation requirement on the
  measured tuple, not a requirement to publish or reuse Strata's private plugin.
- The report records AC1/AC3–AC8 Pass and AC2 Blocked. Those are stage-level observations, not
  acceptance of the complete spec. Remote execution and exact transitive pinning need correction.

Review found the runner reports **workspace** Rolldown 1.2.8 but does not pin/measure the external
consumer's Rolldown. The retained installation and its npm lock resolve **1.2.9**. Runtime results
remain useful; an exact 1.2.8 consumer claim is unproven. Version assertions and failure ownership
must come from the measured graph/diagnostics, not the runner's hard-coded explanations.

Read-only rechecks in this audit reproduced both diagnostics with consumer-local TS 6.0.3
(`--noEmit --skipLibCheck false`). Adding only `esnext.error` removed TS4113 and left TS2307.
Node 22.23.0 reports `typeof Error.isError === "undefined"`: that lib supplies types, not a runtime
polyfill. Registry/source research and alternatives are in
[H3 consumer type compatibility](research/h3-consumer-type-compatibility.md).

**M1: Blocked, partially proven.** SPEC-001 remains Blocked. SPEC-002 has now been implemented and
executed (below) with a measured no-go; a clean type contract and reproducible remote qualification
are still required. No M2 work is authorized.

## SPEC-002: executed, no eligible candidate found (upstream-blocked)

Implemented and executed against `497a23b` (`main`, TypeScript-first tooling cleanup; no `packages/`
drift from `f258fc3`). Full measured evidence, regenerated by every `pnpm test:consumer:types` run:
[docs/research/consumer-type-closure.md](research/consumer-type-closure.md). Detailed AC-level
evidence is recorded in [SPEC-002's Implementation result](specs/002-h3-consumer-type-closure.md#implementation-result).

- **A** reproduces both historical diagnostics (TS4113 on `HTTPError.isError`, TS2307 on `crossws`)
  exactly, on the H3-only reproduction and the packed Strata consumer alike.
- **B** (`esnext.error`) removes TS4113 only; TS2307 remains. Confirms the lib correction alone is
  insufficient, as predicted.
- **C** (`crossws@0.4.12` declared explicitly) does not close the graph: crossws's own root
  declarations unconditionally import `bun` and `cloudflare:workers`/`@cloudflare/workers-types` from
  internal chunk files, producing new TS2307/TS2552 diagnostics. Declaring the peer makes the measured
  diagnostic count worse, not better.
- **D-node-only** (Bun/Workers type packages installed but not activated in `compilerOptions.types`)
  still fails: crossws's own module resolution for the bare `"bun"` import pulls in `bun-types`
  regardless of `types` filtering, conflicting with Node's own declarations; `cloudflare:workers`
  remains unresolved since that ambient module needs explicit `types` activation. This isolates the
  actual mechanism (ordinary module resolution, not `types` inclusion) behind the leak.
- **D-full-providers** (`types: ["node","bun","@cloudflare/workers-types"]`) is disqualified by
  SPEC-002's stop rule regardless of outcome, and independently fails with 125 diagnostics — mostly
  `@cloudflare/workers-types` redeclaring DOM/Node globals that conflict with the existing libs. A
  genuine double no-go, not merely a policy rejection of an otherwise-clean configuration.
- Every diagnostic across all cases traces to `h3`, `crossws`, `bun-types`/`@types/bun`, or
  `@cloudflare/workers-types` declaration files. Zero diagnostics originated in `@strata/core` or
  `@strata/h3` in any case — reconfirming SPEC-001's finding that Strata's own declarations are clean.
- Negative ambient controls confirm Bun/Workers globals are correctly unresolved under Node-only
  `types` and correctly resolved once activated, independent of any H3 diagnostic.
- The CI clean-checkout lint failure recorded above is fixed by build ordering alone: removing
  `packages/*/dist` and running `pnpm lint` reproduces the exact 23 unresolved-type errors from the
  merge CI run; running `pnpm build` first resolves it. `.github/workflows/ci.yml` now builds before
  lint/typecheck and runs `pnpm test:consumer:types` before the existing `pnpm test:consumer` gate.

**Verdict: upstream-blocked.** No candidate satisfies SPEC-002's promotion rules. `pnpm test:consumer`
(SPEC-001's required gate) is unmodified and remains failing on AC2, as required; no promotion was
applied to its fixture. SPEC-001/M1 remain Blocked. Astra owns acceptance of this disposition and any
further M1 direction (upstream issue, alternate closure hypothesis, or continued block).

## Gaps and review findings

- No Angular/Analog/Nitro dependency, DI integration, non-GET decorators, request API, validation,
  guards/interceptors, logging contract, component compiler, navigation protocol or deployment fixture.
- Packed-consumer runtime tests exist; strict installed-package types are blocked. No browser/e2e
  tests, browser bundle assertions or Cloudflare execution.
- Metadata access uses inherited property lookup; route accumulation may reuse an inherited array.
  Undecorated subclasses, decorated siblings, overrides and redecorated subclasses need explicit
  semantics and regression tests. Independent-class tests do not cover inheritance.
- `Get` rejects symbol names but does not explicitly reject static/private methods. The adapter's
  instance lookup catches some invalid shapes later. Supported member shapes need a contract.
- Duplicate routes, registration across repeated calls, partial failure and constructor failures are
  not specified. Do not infer atomicity, conflict handling or stable lifecycle from today's implementation.
- Handler exceptions, `Response`/stream passthrough and cancellation lack dedicated Strata tests.

These remain inputs to M1/M3, not permission for Astra to implement fixes. SPEC-002 addresses the
consumer type-contract blocker; it does not declare the remaining primitive contracts stable.
