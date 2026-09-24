# SPEC-003: Analog request lifecycle and Angular DI feasibility

- Status: **In review.** Implemented and executed; verdict CONDITIONAL GO. See
  [Implementation result](#implementation-result). Astra owns acceptance.
- Baseline: `c671ba4` (`main`, merge of PR #19 — request-scoped controllers and request cleanup)
- Milestone: M2, experiment 2 (Angular DI), on the Analog integration track
- Author/reviewer: Astra; implementer: implementation agent
- Depends on: `@strata/analog` registration (PR #8), `StrataAnalogRequest` (PR #17),
  `controllerFactory` (PR #18), `onCleanup` (PR #19). **Not** on SPEC-001/002: `@strata/analog`
  never exposes H3 v2 declarations.
- Decisions: ADR-001 (standard decorators) and ADR-002 unchanged; DI ownership stays open (no ADR)
- Risks: R03, R04, R05, R12, R13

## Context

On this baseline, `@strata/analog` registers controllers on `nitroApp.router` and creates one
controller per request through an experimental `controllerFactory` (default `new Controller()`).
`onCleanup` callbacks run once the factory and the awaited handler settle. Handlers receive a
provisional `StrataAnalogRequest`. A fixture experiment (PR #18) already built controllers inside
a per-request child of a bare `Injector.create()` and destroyed it through `onCleanup`. That
experiment had four gaps: overlap was timing-based (a 150 ms delay), there was no source trace
behind "a Nitro plugin cannot reach Analog's injector", same-request identity across resolution
sites was untested, and there was no evidence for `inject()` after `await` or for cleanup of Angular
resources on handler failure.

`@strata/h3` still instantiates controllers once at registration; this spec does not change it.

## Problem

We do not know whether Strata controllers in Analog can take part in an Angular request lifecycle
safely: through a supported seam, with request isolation under real overlap, reliable destruction,
and precise `inject()` semantics. Server Components need that answer before they can be built.

## Goals

- Trace the pinned Analog/Angular/Nitro request lifecycle in installed source; classify each
  injector as reachable through a supported seam or not.
- Compare A (reuse Analog's injector), B (Strata-owned Angular injector) and C (explicit host
  bridge); select one on evidence.
- In the real fixture, dev and production: ordinary Angular `inject()` in a controller; barrier-proven
  isolation of overlapping requests; same-request identity; destruction on success, synchronous
  throw and asynchronous rejection; `inject()` behaviour after `await`; unchanged request input,
  native routes and browser-output exclusion.
- Record GO / CONDITIONAL GO / NO-GO with limitations, and reconcile stale current-state docs.

## Non-goals

Server Components, component compiler, hydration/navigation protocols, ForgeCMS, non-GET
decorators, validation, guards/interceptors, modules, a Strata DI container, parameter decorators,
H3 v2 type work, `@strata/h3` lifecycle changes, Workers execution.

## Public API impact

None planned, and none made. Candidate C uses the existing `controllerFactory` + `onCleanup`. Any
new export would require a Changeset, package tests and packed-output verification. `@strata/core`,
`@strata/h3` and `@strata/analog` manifests stay free of Angular.

## Architecture

- Allowed areas: `apps/analog-fixture/src/server/**`, the fixture's Vite configs (only as needed to
  run the experiment, documented), `tools/analog/**`, `docs/**`.
- The consumer owns every Angular injector; `@strata/analog` owns only _when_ the factory and cleanups
  run.
- The controller receives explicit HTTP input only as `StrataAnalogRequest`. DI is for services.
  `request.context` is not used as a container. Controller-side code imports no Nitro/H3 module or
  event type.

## Constraints

- Private/internal Analog APIs may be read to trace behaviour but must not be depended on.
- No `skipLibCheck`/strictness changes, no `node_modules` patches, no hidden diagnostics.
- Concurrency must be proven with a barrier, not with `Promise.all` and timing.
- A second DI universe must be named, and its non-shared parts listed.

## Acceptance criteria

| ID   | Criterion                                                                                                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1  | Research report lists exact versions and source locations for SSR, server-function and Nitro-route lifecycles; supported vs private seams are classified.                                                                          |
| AC2  | Candidates A/B/C are compared; the selected model is justified; the "second DI universe" limitation is explicit.                                                                                                                   |
| AC3  | A controller constructed through the factory resolves `providedIn: 'root'` and request-scoped services with `inject()` in dev and production.                                                                                      |
| AC4  | Two requests proven simultaneously suspended in their handlers get different request-scoped instances, each bound to its own request, and share the application-scoped one; a lone request at the barrier does not pass (control). |
| AC5  | Within one request, the controller and another request-scoped service resolve the same request-scoped instance.                                                                                                                    |
| AC6  | Request injectors are destroyed, running `ngOnDestroy` and `DestroyRef` callbacks, on success, synchronous handler throw and asynchronous rejection.                                                                               |
| AC7  | `inject()` in a handler body is characterized before and after `await`; captured dependencies are shown to work after `await`.                                                                                                     |
| AC8  | `StrataAnalogRequest` still reaches the handler, and the injected request token is the same object.                                                                                                                                |
| AC9  | Native Analog routes, SSR and pre-existing Strata routes still pass in dev and production.                                                                                                                                         |
| AC10 | DI experiment markers are absent from `dist/client`, `dist/analog/public` and `dist/ssr`; present in server output.                                                                                                                |
| AC11 | No Angular dependency in `@strata/core`, `@strata/h3` or `@strata/analog`; no new package unless justified.                                                                                                                        |
| AC12 | STATE/ROADMAP/ARCHITECTURE/README distinguish the H3 consumer qualification track from the Analog track without removing the H3 blocker.                                                                                           |

## Required tests

| Test / command                                                                                  | AC                     |
| ----------------------------------------------------------------------------------------------- | ---------------------- |
| `pnpm test:analog` — "Angular DI experiment (…): two requests held at a rendezvous"             | AC3–AC5, AC7, AC8      |
| `pnpm test:analog` — "… one request alone at a rendezvous (control)"                            | AC4 (negative control) |
| `pnpm test:analog` — "… handler throws synchronously", "… async handler rejects after an await" | AC6                    |
| `pnpm test:analog` — onCleanup-only release; no Nitro/H3 types in controller-side files         | AC6, AC11              |
| `pnpm test:analog` — typecheck probe including the DI plugin against Nitro's types              | AC3                    |
| `pnpm test:analog` — marker scan and existing route/SSR checks                                  | AC9, AC10              |
| `pnpm --filter @strata/analog test` (existing lifecycle/cleanup suites, unchanged)              | AC6, AC8               |
| `pnpm format:check`, `lint`, `typecheck`, `test`, `build`                                       | all                    |

## Compatibility concerns

Measured only on Node 22.23.0, Angular 22.1.7, Analog 2.7.2, Nitro 2.13.4 (H3 1.15.11), TypeScript
6.0.3, Vite 8.3.0, `node-server` preset. Workers, other presets and other Analog lines (including the
H3 v2 alpha) are unverified.

## Risks

R03 (private Analog seams): resolved negatively for this tuple, since no supported seam exists and
none is used. R04 (DI leaks/duplication): partially resolved on Node, with the duplication now
explicit. R05: bundle exclusion re-verified for this experiment only. R12: untouched. R13: first
server-size measurement recorded.

## Definition of Done

All required tests pass. The research report and the regenerated integration baseline are
committed. Docs are reconciled. The spec index is updated. No Changeset is needed while public API is
unchanged.

## Explicitly out of scope

Implementing the next step (Server Component PoC), any public DI helper, and any change to
`@strata/h3`.

## Implementation result

Executed on branch `feat/spec-003-analog-di-feasibility` from `c671ba4`. Full evidence:
[Analog DI feasibility](../research/analog-di-feasibility.md). Executed tables:
[integration baseline](../research/analog-integration-baseline.md).

| AC   | Result | Evidence                                                                                                                                     |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1  | Pass   | Lifecycle trace with file:line references; SSR and server-function injectors not reachable through supported seams.                          |
| AC2  | Pass   | A unavailable (and blocked by two Angular runtimes in production); B rejected as package-owned; C selected with consumer-owned app injector. |
| AC3  | Pass   | `catalogInstance: 1`, `@Injectable()` request services resolved; typecheck probe passes.                                                     |
| AC4  | Pass   | `met: true` pair with distinct identities bound to own product ids, `maxInjectorsAlive: 2`; lone request `met: false`.                       |
| AC5  | Pass   | `auditSharesIdentity: true`.                                                                                                                 |
| AC6  | Pass   | Counter deltas 2/2/2/2 (overlap) and 1/1/1/1 (control, throw, reject).                                                                       |
| AC7  | Pass   | `NG0203` before and after `await` inside handlers; captured fields used after `await`.                                                       |
| AC8  | Pass   | `injectedRequestIsArgument: true`; `request.params` drives the response.                                                                     |
| AC9  | Pass   | All pre-existing `test:analog` checks pass in both modes.                                                                                    |
| AC10 | Pass   | Marker absent from client/public/SSR bundle; present in `dist/analog/server`. `@angular/compiler` traced server-only.                        |
| AC11 | Pass   | Package manifests unchanged; no `@strata/angular`.                                                                                           |
| AC12 | Pass   | STATE, ROADMAP, ARCHITECTURE, README and the spec index updated.                                                                             |

Deviations, recorded rather than hidden:

- The fixture's Vite configs gained `nitro.moduleSideEffects: ["@angular/compiler"]`. Without it,
  the Nitro bundle drops the JIT compiler import and the whole server fails at startup.
- The fixture's DI experiment was rewritten, not extended: the application injector now comes from
  `createApplication()` (for `providedIn: 'root'` and `@Injectable()`) instead of a bare
  `Injector.create()`, and the timing-based overlap became a barrier.
- Abort/timeout cleanup, Workers and provider overrides were not exercised (see report).

Verdict: **CONDITIONAL GO**. Next bounded step: the first strict Server Component feasibility PoC.
