# Roadmap to 1.0

Baseline: [STATE](STATE.md). Milestones are capability gates, not calendar promises or mandatory
version numbers. M1–M4 may produce experimental 0.x releases; M5 produces release candidates.
Each future slice gets its spec immediately before implementation. SPEC-001 and SPEC-002 were
executed and remain Blocked; SPEC-003 is implemented and in review (see [specs](specs/README.md)).

**Two tracks (reconciled 2026-09-24).** The diagram below was drawn as one sequence. In practice the
M1 blocker belongs to `@strata/h3`'s H3 v2 declarations, and `@strata/analog` never exposes them. So:

- **H3 consumer qualification track** (M1): upstream-blocked; stays Blocked and visible. It still
  gates any claim that `@strata/h3` consumers typecheck strictly, and any M3+ stabilization that
  relies on `@strata/h3`.
- **Analog integration / Server Component feasibility track** (M2): proceeds on `@strata/analog`,
  which has its own runtime and bundle evidence. Its experiments do not claim M1, and M1 does not
  pretend they have not happened.

```text
M0 existing core + H3 GET
  → M1 consumer compilation evidence
  → M2 integration and strict Server Component feasibility (go / no-go)
  → M3 usable HTTP architecture + stable Analog integration
  → M4 production component/navigation contract
  → M5 deployment hardening + real consumer
  → 1.0 release audit
```

M2 deliberately precedes broad HTTP feature work: the riskiest requirement determines whether the
1.0 destination is viable. M2 has sequential, separately specified experiments, not one large
implementation assignment. Baseline prototype endpoints are sufficient to exercise them.

## M0 — Existing experimental primitives

**Status:** implemented baseline, not a stable release.

- Capability: declarative `Controller`/`Get` metadata executes on a caller-owned H3 v2 app.
- Hypothesis already exercised: an independent metadata core can drive a thin runtime adapter.
- Evidence: 34 existing tests pass locally; limitations and missing cases are in STATE.
- Still changeable: all public experimental APIs, metadata/lifecycle details and package policy.

## M1 — A consumer can compile and run the primitive

**Status:** Blocked, partially proven. SPEC-001 executed; strict consumer types still fail.

- Capability: a fresh external consumer uses packed Strata packages and its own standard-decorated
  controller with a reproducible TypeScript/Vite compilation recipe.
- Hypothesis: internal test transforms have not hidden broken package exports, symbol initialization,
  metadata emission or consumer build requirements.
- Evidence: [SPEC-001](specs/001-packed-consumer-compilation.md) proves packed installation,
  dependency rewriting/single core, standard-decorator metadata and both Node runtime paths with
  real H3/native requests. Direct Vite retains decorators and fails in Node; that is successful
  characterization, not a failure of the reference runtime path.
- Blocker: AC2 remains unsatisfied by H3 declarations (TS4113 lib mismatch and TS2307 optional
  peer type leakage). Adding `esnext.error` alone is insufficient. Exact external Rolldown pinning
  also needs repair; remote CI currently stops at pre-build lint, before consumer qualification.
- SPEC-002 result: executed, no eligible closure; upstream-blocked (see [STATE](STATE.md)). Its
  original framing follows. [SPEC-002](specs/002-h3-consumer-type-closure.md) tests one bounded hypothesis: a declared,
  pinned TypeScript/lib/type-dependency closure can qualify the existing H3 v2 consumer without
  suppression or dependency patches. If falsified, retain an upstream reproduction and keep M1
  Blocked; completed investigation is not gate completion. Primitive semantic gaps remain in STATE.
- Gate: installed tarballs, public declarations, executable production output and route behavior
  verified without workspace source aliases. Evidence must distinguish package build from user-code
  compilation. A clean strict typecheck remains mandatory; successful emitted JS cannot replace it.
  No public compiler package is needed to pass this gate. M2 claims that depend on `@strata/h3`
  remain gated on M1; the Analog-track experiments do not depend on it (see the two-track note).
- Still changeable: consumer build recipe, package boundaries, distribution and all framework APIs.

## M2 — Prove the integration path and the hardest UI requirement

**Status:** in progress on the Analog track; prototype-only, not production-ready. M1 remains
Blocked for `@strata/h3` (see the two-track note above). Experiment 1 is partially evidenced by the
[Analog integration baseline](research/analog-integration-baseline.md): Nitro 2 / H3 v1 seam,
`@strata/analog` rather than an H3 bridge, standard decorators in dev and production, and Angular-graph
decorator failures recorded. Base paths, cookies, abort and Workers are still open. Experiment 2 has a
**CONDITIONAL GO** ([SPEC-003](specs/003-analog-request-lifecycle-angular-di.md),
[report](research/analog-di-feasibility.md)). Experiment 3 is next.

Capability: a pinned minimal Analog fixture demonstrates, or falsifies, the route from a Strata
controller to request services and from a server-only component to an interactive Angular child.

Experiments, in dependency order:

1. **Runtime and compiler seam.** Resolve exact Angular/Analog/Nitro/H3/TS/Vite versions. Compare a
   narrow H3 v1 adapter path, an explicit Web Request/Response bridge around H3 v2, and an upstream
   supported newer runtime if actually available. Verify base paths, headers/cookies, errors and
   abort behavior. Exercise consumer decorators with Angular AOT in dev and production; prove
   transform order and metadata retention. Select neither multiple-major support nor a plugin by fiat.
2. **Angular DI.** Trace the request injector as described in ARCHITECTURE; test identity, scopes,
   concurrency, cleanup, synchronous `inject()` and server-function coexistence. A private hook or
   fork must be identified, not disguised as stable integration. _Result (SPEC-003):_ no supported
   Analog seam exposes the SSR or server-function injector. Consumer-owned `createApplication()` +
   per-request `createEnvironmentInjector()` via `controllerFactory`/`onCleanup` passes isolation,
   identity and cleanup tests on Node. It is a separate DI universe from SSR and server functions,
   needs the JIT compiler in the Nitro bundle, and Workers/abort remain open.
3. **Component compiler/graph PoC** (next bounded step). Build on SPEC-003's lifecycle: one
   server-only component/service plus one interactive Angular child, with production bundle
   assertions. Server data service plus `ProductDetails` absent from every
   browser artifact, interactive `AddToCartComponent` present and actually hydrated after SSR.
   Prove template compilation and boundary ownership, direct/transitive import rejection and
   production bundle assertions. Attempt the same minimal output under a Workers runtime.
4. **Navigation feasibility probe.** Exercise a second route with document navigation and assess
   whether a client-router subtree approach has a supported Angular lifecycle. Record tradeoffs and
   failures; the final protocol is specified in M4, after these results.

Hypotheses: supported framework extension points can preserve the strict graph split, share request
services and hydrate explicit children without a second DI container or shipping server code.

Gate: reproducible fixtures and a go/no-go report for every experiment; one pinned viable runtime
path, a documented consumer compilation strategy and strict component graph/hydration evidence.
If only SSR works, record no-go and keep 1.0 blocked. If upstream work is required, record its public
issue and version dependency and replan before broad API work. Do not turn a prototype into support.

Still changeable: component declaration syntax, compiler/plugin packaging, DI bridge, H3 target for
Analog and navigation strategy. Write relevant ADRs only after the evidence exists.

## M3 — Usable HTTP domains inside Analog

**Status:** planned; depends on M2's viable seams.

- Capability: controllers and services handle real HTTP domains inside an Analog app with defined
  request lifetimes and native H3 escape hatches.
- Hypothesis: a small explicit architecture covers those needs without replicating a backend platform.
- Work in separate slices: close metadata/member/registration contracts; add Post/Put/Patch/Delete;
  compare request-input APIs before selecting one; define params/query/body/headers and Standard
  Schema validation; safe errors; Angular providers/lifetimes; guards and interceptors with explicit
  order, cancellation and logging; stabilize consumer compilation and Analog integration.
- Gate: core/adapter contracts, installed consumers, Analog SSR and existing server functions remain
  compatible; concurrent request isolation and error/authorization tests pass on Node and Workers.
  Consumer compilation is a prerequisite to calling Analog integration stable. Request-input and
  lifecycle decisions must precede their public APIs.
- Still changeable: HTTP names and ergonomics through experimental releases; component protocol
  remains provisional. Breaking changes require explicit migration notes.

## M4 — Server Components with a production rendering contract

**Status:** planned; depends on M2 component feasibility and M3 request/security contracts.

- Capability: strict server-only UI composes Angular interactive descendants under a defined initial
  SSR and navigation strategy.
- Hypothesis: the PoC remains correct across navigation, nested boundaries, errors and optimization.
- Work: choose document navigation or a justified router protocol; specify serialization, boundary
  identity, authorization, caching, error recovery and deployment-version skew. Integrate ordinary
  hydration, incremental hydration and `@defer`; declare supported composition rules and reject the
  rest clearly. Add build-time forbidden-import diagnostics and production graph assertions.
- Gate: SSR, browser interaction and navigation tests pass; no server implementation or transitive
  server dependency in any browser output; adversarial leak tests fail closed; selected strategy
  works on both target runtimes. Freeze the protocol through evidence-backed ADRs, not the example API.
- Still changeable: ergonomics and tuning before RC; security invariants cannot be weakened.

## M5 — Production evidence and release candidates

**Status:** planned; depends on M4.

- Capability: a deployed production fixture and a real application use the complete path.
- Hypothesis: deployment, packaging, upgrades and real traffic do not invalidate fixture guarantees.
- Work: qualify a small exact compatibility matrix; deploy Node and the selected Cloudflare shape;
  enforce measured bundle/runtime budgets, load/concurrency and cleanup tests; verify published
  package candidates; exercise upgrade/rollback and safe diagnostics; finish examples and migrations.
  Adopt in ForgeCMS only after fixtures pass, or document another real consumer.
- Gate: every [1.0 exit criterion](RELEASE-1.0.md) has evidence for the same candidate and supported
  matrix; real consumer uses controllers/services and production Server Components, including the
  selected navigation path. Agree consumer-specific observation duration and service objectives
  before trial, record results and regressions, and repeat after material fixes.
- Still changeable: fixes and explicit RC migrations. No new broad platform capabilities.

## 1.0.0 — Release decision

Astra reviews evidence and architectural coherence; maintainers accept the release audit. A demo,
passing unit tests or an unpublished consumer branch cannot substitute for production proof.
Anything missing from RELEASE-1.0 keeps the candidate below 1.0. Future milestones may change
through new evidence, but 1.0 cannot quietly become “controllers work.”
