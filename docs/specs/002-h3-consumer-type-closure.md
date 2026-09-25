# SPEC-002: H3 consumer type closure

- Status: **Blocked** — implemented and executed; no candidate satisfies the promotion rules. See
  [Implementation result](#implementation-result). Astra owns final acceptance of this disposition.
- Baseline: `f258fc3` (`main`, SPEC-001 merge); use the subsequent documentation-only handoff commit
  and record its SHA. Stop if production packages or the tested dependencies have drifted.
- Milestone: M1; M2 remains gated
- Author/reviewer: Astra; implementer: a separate implementation agent
- Depends on: SPEC-001's existing tooling and runtime evidence, **not** acceptance of its failed AC2
- Decisions: ADR-001, ADR-002 unchanged; dependency/peer and public compiler decisions remain open
- Risks: R01, R14, R16, R18, R19, R20

## Context

SPEC-001 is implemented, executed and merged. External tarballs and the consumer's own decorators
work through `tsc → JS → Vite SSR → Node`, with real H3 requests. Strict types remain blocked.
The [dated review](../research/h3-consumer-type-compatibility.md) verified npm H3 `latest` is still
2.0.1-rc.32 and no post-release code fix exists on the inspected upstream head. Do not implement
an upgrade to a guessed release or start another compiler package.

## Problem

We do not yet have a reproducible, acceptable type contract for an HTTP-only Node consumer.
H3's declaration assumes `esnext.error`, then reaches an optional crossws dependency whose public
type graph reaches other runtimes. The next smallest unresolved question is whether **explicit
compiler libs and a closed set of published type dependencies can qualify this same H3 v2 tuple
without suppressions, patched declarations or foreign runtime globals**.

This spec tests that single hypothesis. A measured no-go resolves the configuration-versus-upstream
repair decision, but does not close M1. No known clean published recipe is promised by this handoff.

## Goals

- Separate the H3 lib requirement from optional-peer and transitive platform-type leakage using
  fixed, isolated controls that a smaller implementation agent can execute without policy choices.
- Qualify a clean Node consumer recipe if the allowed closure works; otherwise produce a minimal,
  shareable H3-only reproduction and exact upstream repair requirements, keeping M1 Blocked.
- Ensure the existing consumer gate measures its actual versions, attributes diagnostics honestly,
  and can be reached on a fresh CI checkout.

## Non-goals

No H3 major migration, general dependency upgrade, framework feature, upstream fork/patch,
public plugin, package publication, Angular/Analog/Nitro integration or production deployment.
Installing a diagnostic type provider makes no runtime support claim for that platform.

## Evidence from SPEC-001

| Evidence                                                                      | Disposition carried forward                                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Packed core/adapter, dependency rewriting, one core resolution                | Positive external-install evidence; retain assertions and tarball identities.                      |
| Metadata, guarded symbol, sync/async and native H3 requests, instance binding | Positive runtime evidence for both reference stages. Repeat on the exact candidate tuple.          |
| TS4113 in H3's `HTTPError.isError`                                            | The review's TS 6.0.3 probe removed it by adding only `esnext.error`.                              |
| TS2307 for crossws; further platform imports when installed                   | Independent declaration-closure blocker; no clean recipe yet.                                      |
| Direct Vite builds, then Node rejects decorators                              | Successful characterization; do not turn this into an expected passing runtime arm.                |
| Report says Rolldown 1.2.8 from workspace; retained consumer has 1.2.9        | Fix pinning and measure consumer-local resolution; original results are not a certified 1.2.8 run. |
| Merge CI fails at pre-build lint; consumer step skipped                       | Build prerequisites before type-aware lint; verify on a fresh checkout. Not a remote AC2 result.   |

## Public API impact

None: retain all Strata exports, signatures, versions, runtime semantics and package dependencies.
No changes under `packages/`, including manifests and private transforms. Add a root development
command `test:consumer:types` for the bounded matrix/reproduction. Preserve `test:consumer` as the
required qualification gate: it must remain nonzero while its positive reference typecheck fails.
A successful diagnostic experiment must not be presented as a supported framework installation.

## Architecture / approach boundaries

### Owned areas

Use `tests/consumer/type-compatibility/` for minimal inputs and `tools/consumer/` for orchestration;
reuse existing public behavior assertions and the authored controller. Root `package.json` may gain
the command. The consumer fixture manifest may add exact experiment-only constraints. The existing
reference fixture may gain `esnext.error` only under the promotion rule below. No workspace tsconfig
changes. A root lockfile change is allowed only if necessary for existing tooling, not to upgrade it.

In `.github/workflows/ci.yml`, move the existing build step before type-aware lint (after install),
retaining lint/typecheck/tests and required consumer qualification. Run the type experiment after
build; do not use `continue-on-error` to make required qualification green. If the clean-checkout
lint issue is not resolved by build ordering, record the new evidence and stop expanding that fix.

Save new measured evidence in `docs/research/consumer-type-closure.md`; do not overwrite the original
SPEC-001 report. Make the runner's report destination/experiment label explicit as needed. Update
STATE, COMPATIBILITY and spec status only to reflect measured outcomes; Astra owns milestone acceptance.

### Fixed tuple and controls

Use Node **22.23.0**, pnpm **10.30.1**, consumer-local TS **6.0.3**, `@types/node` **22.20.3**,
Vite **8.3.0**, consumer Rolldown **1.2.8**, H3 **2.0.1-rc.32**, srvx **1.0.5**, rou3 **0.9.2**.
Pin and assert actual resolutions, including the Rolldown instance used by Vite; constrain only the
external fixture graph as needed. Record npm's actual version and each generated lockfile digest.
Use a lockfile or retained exact resolved graph to rerun the same inputs; retain normalized lock
metadata without workstation paths or committed node_modules/tarballs.

Each case is a new external directory. Share only immutable input files/tarballs, not node_modules
or emitted output. Use ESM/NodeNext, target ES2023, strict true, skipLibCheck false, no legacy
decorators or emitted reflection metadata, and the SPEC-001 libs/types except as explicitly listed:

| Case                    | Dependencies/configuration beyond original baseline                                    | Purpose                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — historical control  | No crossws; original libs, `types: ["node"]`                                           | Reproduce TS4113 and crossws TS2307 without any Strata source aliases.                                                                                                                                               |
| B — narrow lib          | A plus `esnext.error`                                                                  | Prove TS4113 disappears while the independent crossws error remains.                                                                                                                                                 |
| C — published peer      | B plus `crossws@0.4.12`; retain `types: ["node"]`                                      | Test whether an explicit peer alone closes the Node declaration graph; retain every transitive diagnostic.                                                                                                           |
| D — provider diagnostic | C plus `@types/bun@1.4.2`, `bun-types@1.4.2`, `@cloudflare/workers-types@5.20260917.1` | First keep Node-only types; then separately load `types: ["node", "bun", "@cloudflare/workers-types"]`. Determine missing providers versus conflicting/foreign globals. Neither variant is automatically promotable. |

No additional provider chase, downgrade, TS 7 experiment, alternate H3 major or arbitrary release
search is authorized. Unexpected version availability/engine incompatibility is an explicit blocker,
not permission to substitute a mutable tag. New upstream fixes require Astra to revise this spec.

### Minimal reproduction and public consumer checks

1. Add an H3-only TypeScript input importing `H3` and `HTTPError` from the public root. Instantiate an
   app, register a native GET, and use `HTTPError.isError`. Run each matrix case with consumer-local
   `tsc --noEmit`; record complete diagnostic code/file/message and exit status. Use `--listFiles`
   or resolution tracing to identify the actual paths to crossws and platform declarations.
2. Test ambient availability separately: Node-only candidates must reject direct use of undeclared
   `Bun` and Worker-only `WebSocketPair` globals. Assert the unresolved-name diagnostics for those
   exact identifiers separately from any H3 declaration errors; an unrelated nonzero exit is not
   evidence that the globals are absent. Use negative compiler invocations (without
   `@ts-ignore`, ambient stubs or hiding library errors). The `esnext.error` exception is explicit:
   record Node's native availability and do not call native `Error.isError` as a runtime prerequisite.
3. For each case, run the same strict check against the existing packed Strata consumer as well.
   This distinguishes an upstream H3 failure from any additional Strata declaration failure.
4. Preserve diagnostic-only cases as controls. A candidate qualifies only under the rules below.
   For a qualifying candidate, typecheck and emit with `noEmitOnError: true` from empty output
   directories, then run both reference stages and the existing symbol/HTTP/negative assertions.
   Recharacterize direct Vite independently with its actual resolved versions.
5. If no candidate qualifies, preserve the existing runtime assertions on the historical emission
   path as diagnostic evidence, explicitly labeled “emitted with type errors.” That path cannot
   pass the qualification gate. Retain a standalone reproduction that needs no Strata package or
   private source; document commands, pinned graph, diagnostics and the upstream boundary to fix.

### Promotion and stop rules

- B's `esnext.error` addition is an eligible explicit correction to SPEC-001's lib assumption;
  it is not a relaxation of strictness. It is insufficient alone.
- C is eligible only if its entire declaration graph checks cleanly under the Node-only types and
  negative ambient controls. D can establish why it fails or test an installed but unactivated
  provider closure. A D variant is eligible only if no Bun/Workers ambient environment is required,
  no foreign globals appear, no conflicting Node definitions are hidden and all strict checks pass.
- A clean D result **only after enabling foreign globals is no-go for the Node contract**. Do not
  promote a workaround that presents other runtimes' APIs as available to Node consumers.
- If an eligible candidate exists, apply exactly its tested libs and explicit dependency pins to
  the consumer qualification fixture and documentation, then rerun the entire gate. Describe it as
  an experimental consumer configuration requirement, not an automatic Strata dependency fix.
  No peer/dependency policy is changed in the shipped packages by this spec.
- If none qualifies, do not change the required reference gate to expect failure. Report
  **upstream-blocked**, with a local issue-ready reproduction (do not post it), separate requirements
  for H3's ambient lib assumption and the optional-peer/platform type boundary, and no claimed fix.
  Keep SPEC-001/M1 Blocked. A fork, declaration bundling repair or public dependency policy requires
  a new architectural review, not an implementation-agent improvisation.

## Compatibility constraints

- No `skipLibCheck`, `skipDefaultLibCheck`, disabled strict checks, ambient module shims, ignored
  diagnostics, edited node_modules declarations, patch-package, fake type exports, casts replacing
  H3's public signature, source aliases, internal H3 subpaths or alternative module resolution.
- Do not replace the existing `DOM`/`DOM.Iterable` libs merely to avoid provider conflicts. Explain
  actual web API type ownership before any such contract change in a later review.
- Preserve the public root imports and the single-core resolution assertion. A fixture override
  for the local core tarball is still permitted; it is not a general dependency repair mechanism.
- Keep all standard-decorator/metadata constraints and reference runtime behavior from SPEC-001.
- No Node-only result certifies Bun, Workers, Angular, Analog, Nitro or browser compatibility.

## Acceptance criteria

| ID  | Observable result                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC1 | All A–D cases are independently installed with exact measured versions, normalized config/graph evidence and no workspace source access. Unavailable dependencies are infrastructure failures, not expected diagnostics.                                                                         |
| AC2 | H3-only and packed Strata checks report actual diagnostics per case. A reproduces both causes; B removes only TS4113. C/D trace every remaining dependency/global conflict rather than attributing all failures to a hard-coded H3 message.                                                      |
| AC3 | The report gives a deterministic qualification verdict under the promotion rules, including ambient negative controls. Only an eligible zero-diagnostic candidate can become the reference contract. No-go includes the standalone upstream reproduction.                                        |
| AC4 | If eligible, the reference typecheck exits 0 with strict declaration checks, and fresh emitted JS plus its Vite bundle pass all metadata, sync/async/native H3 and instance-binding checks. If no candidate qualifies, this positive criterion is **Blocked**, never passed by expected failure. |
| AC5 | Actual consumer H3/core/Rolldown resolution is asserted. Wrong versions, missing output, a deliberate consumer type error, missing tarball or corrupted response cause qualification failure; direct-Vite characterization cannot mask it.                                                       |
| AC6 | A fresh CI checkout builds before lint, reaches the type/consumer gates, and retains diagnostics on failure. Link the run and separate expected matrix observations from the required positive qualification status. Remote checks not run remain open.                                          |
| AC7 | No production/API/package dependency changes; updated evidence documents exact consumer obligations, unsupported cases and a SPEC-001 acceptance crosswalk. Original historical evidence remains intact.                                                                                         |

## Required tests

- AC1/AC2: execute A–D H3-only and packed-consumer typechecks; assert diagnostic categories and
  origin rather than snapshotting complete compiler wording. Record effective compiler options
  and loaded declarations. Distinguish install/spawn errors from compiler results.
- AC3: foreign-global negative controls and eligibility classifier; demonstrate that an incompatible
  provider variant is never promoted even if its compiler exit code happens to be zero.
- AC4: all SPEC-001 public metadata/symbol and H3 runtime assertions on a type-clean candidate.
  Record direct-Vite compile/execution separately; an observed failure here is characterization.
- AC5: inject one ordinary consumer type mismatch into a disposable case and prove qualification
  exits nonzero; verify missing output and dependency-version mismatches fail closed. Retain the
  existing missing-tarball and bad-response controls.
- AC6/AC7: clean-checkout workflow validation, linked CI, changed-file scope, report and config review.

Run `pnpm test:consumer:types`, `pnpm test:consumer`, `pnpm build`, `pnpm lint`, `pnpm typecheck`,
`pnpm test` and changed-file formatting checks with the repository's `rtk` prefix. Build before
lint on a clean tree. Matrix tooling may return success for faithfully measured diagnostic controls;
`test:consumer` must still fail unless the required positive reference criteria pass.

## Risks

R18/R19/R20 are observed declaration/lib/optional-peer compatibility risks. This experiment may
falsify the configuration-only remedy and require upstream work. R16 includes reproducibility and
CI reachability; correcting those does not cure the declaration graph. R01 retains positive package
and consumer-lowering evidence; direct Vite and Angular transform integration remain separate.

## Definition of Done

Provide the fixture/runner changes, exact graph and commands, report keyed to AC1–AC7, clean-checkout
CI evidence and a qualified-candidate or upstream-blocked verdict. No Changeset is needed for this
tooling-only slice; explain why. A fully measured no-go completes the experiment deliverables but
leaves the spec **Blocked** on positive AC4 and M1 **Blocked**. Do not mark a compatibility fix done
merely because negative controls passed.

Astra may accept this spec and close M1 only after the positive strict type/runtime gate passes,
the explicit new lib/dependency contract is reviewed, the actual pinned tuple is reproduced and
remote qualification passes. Preserve SPEC-001's original failed experiment; if its fixed contract
is replaced, mark it Superseded with the accepted SPEC-002 evidence, not retroactively passed.
No M2 spec or implementation is part of this handoff.

## Explicitly out of scope

Production `packages/*` edits; H3 v1 or dual adapters; public compiler/Vite packages; Angular or
Analog integration/DI; ServerContext; new HTTP verbs; params/body/query; guards/interceptors;
Server Components; navigation; runtime polyfills; upstream PRs/issues sent without instruction;
package publication; accepting a patch-only proof as an ordinary released consumer installation.

## Implementation result

- Baseline `f258fc3` → implemented and executed against `497a23b` (`main`, merge of the TypeScript-first
  tooling cleanup). No drift in `packages/` between the two; only tooling/documentation changed.
- Full measured evidence, regenerated by every `pnpm test:consumer:types` run:
  [docs/research/consumer-type-closure.md](../research/consumer-type-closure.md).
- Changed files: `tests/consumer/type-compatibility/**` (H3-only reproduction, ambient-probe and
  mismatch-control fixtures), `tools/consumer/type-closure/**` (matrix runner, diagnostic classifier,
  report renderer — all TypeScript), `docs/research/consumer-type-closure.md` (evidence),
  `package.json` (`test:consumer:types` script), `.github/workflows/ci.yml` (build moved before
  lint/typecheck; new type-closure step added before consumer qualification), `eslint.config.ts`
  (excludes the new foreign fixture directory, mirroring the existing SPEC-001 exclusion). No file
  under `packages/` changed; `tests/consumer/fixture` and `tools/consumer/run.ts` (SPEC-001) are
  untouched — the new matrix runner is fully independent so the existing required gate cannot regress.
- **Verdict: upstream-blocked. No case (A–D) satisfies the promotion rules.**
  - **A** reproduces both historical diagnostics exactly (TS4113 on `H3.HTTPError.isError`, TS2307 on
    `crossws`), on both the H3-only reproduction and the packed Strata consumer.
  - **B** (`esnext.error` added) removes TS4113; TS2307 (crossws) remains on both targets. Confirms
    the lib correction is real but insufficient alone, exactly as the spec predicted.
  - **C** (crossws `0.4.12` declared explicitly) does **not** close the graph: crossws's own root
    declarations unconditionally import `bun` and `cloudflare:workers`/`@cloudflare/workers-types`
    from its `_chunks/bun.d.mts` and `_chunks/cloudflare.d.mts` files, producing 4 new TS2307/TS2552
    diagnostics — worse than B, not better. Not eligible.
  - **D-node-only** (Bun/Workers type packages installed but _not_ listed in `compilerOptions.types`)
    still fails: `@types/bun`'s module resolution for the bare `"bun"` import crossws already performs
    is triggered by ordinary module resolution, not by `types` inclusion, so `bun-types/globals.d.ts`
    and `overrides.d.ts` load anyway and conflict with Node's own declarations (`TS2694`, `TS2552` ×2,
    `TS2304`). `cloudflare:workers` remains unresolved (that ambient module needs explicit `types`
    activation). This establishes _why_ installed-but-inactive providers still fail: crossws's own
    unconditional imports, not TypeScript's `types` filtering, are what leaks Bun into a Node-only
    program. Not eligible.
  - **D-full-providers** (`types: ["node","bun","@cloudflare/workers-types"]`) is disqualified by the
    stop rule regardless of outcome, and independently does not typecheck: 125 diagnostics, dominated
    by `@cloudflare/workers-types` redeclaring DOM/Node globals (`Buffer`, `process`, `global`,
    `Response`, `Request`, `EventListener`, …) that conflict with the existing `DOM`/`@types/node`
    libs. This is a genuine double no-go (policy-disqualified _and_ not clean), not merely a policy
    rejection of an otherwise-working configuration.
  - Every diagnostic in every case traces to `h3`, `crossws`, `bun-types`/`@types/bun`, or
    `@cloudflare/workers-types` declaration files. Zero diagnostics originated in `@strata-sc/core` or
    `@strata-sc/h3` in any case, on either target — the classifier asserts this per case and the runner
    treats any Strata-origin diagnostic as a self-test failure (none occurred).
- **Negative ambient controls (AC3):** a probe referencing only `Bun`/`WebSocketPair` (no H3, no
  Strata) correctly reports both as unresolved names under case B's Node-only `types`, and correctly
  resolves both once Bun/Workers types are activated (case D-full-providers' `types` set) — proving
  ambient-global availability is measured independently of any H3 diagnostic, and that D-full-providers
  would never be promotable purely on policy even before its 125 diagnostics are considered.
- **AC5 disposable self-tests:** a deliberate consumer-authored type mismatch (`TS2322`) was correctly
  classified with origin `consumer-authored`, distinct from upstream-origin diagnostics in the same
  run. A disposable install pointed at a nonexistent `h3` version correctly failed closed (nonzero
  `npm install`). Both are runner self-tests, not part of the A–D verdict.
- **H3-only reproduction:** `tests/consumer/type-compatibility/h3-only/src/reproduction.ts` imports
  only `H3` and `HTTPError` from the public `h3` root, instantiates an app, registers one native GET
  and calls `HTTPError.isError`. It needs no Strata package and is never executed, only typechecked
  per case — isolating an H3 declaration problem from a Strata declaration problem by construction.
- **Packed Strata consumer:** reused `tests/consumer/fixture` (SPEC-001's authored controller)
  unmodified, with only `tsconfig.json`'s `lib`/`types` and `package.json`'s dependencies patched per
  case by the runner. No new controller or assertions were introduced.
- **Runtime/Vite (AC4):** not applicable — no case is eligible, so AC4's positive path is **Blocked**,
  not passed by an expected-failure substitute. SPEC-001's existing emitted-JS/Vite runtime evidence
  on the historical (non-clean) typecheck stands unchanged and is not re-claimed as a type-clean result.
- **CI (AC6):** `.github/workflows/ci.yml` now runs build before lint/typecheck (reproducing and fixing
  the exact clean-checkout failure recorded in STATE: removing `packages/*/dist` and running `pnpm lint`
  reproduces the 23 unresolved-type errors from the merge CI run; running `pnpm build` first resolves
  it, verified locally on this checkout). `pnpm test:consumer:types` runs after `pnpm test` and before
  `pnpm test:consumer`. Remote execution of this exact workflow was not independently observed by this
  implementation pass; Astra/CI must confirm the linked run.
- **Versions actually resolved:** Node `v22.23.1` (pinned `22.23.0` — patch drift in the execution
  environment, reported rather than silently substituted), pnpm `10.30.1`, npm `10.9.8`, TypeScript
  `6.0.3`, `h3@2.0.1-rc.32`, `crossws@0.4.12`, `@types/bun@1.4.2`, `bun-types@1.4.2`,
  `@cloudflare/workers-types@5.20260917.1` — all matching the spec's fixed pins exactly except Node's
  patch version. No infrastructure/version blocker occurred: every pinned package resolved to its
  exact mandated version.
- Changesets: none. No production/package behavior changed; this is tooling/research/compatibility
  qualification, per [COMPATIBILITY](../COMPATIBILITY.md)'s pre-1.0 Changeset rule.
- No promotion was applied to `tests/consumer/fixture` or its `package.json`/`tsconfig.json`: SPEC-002's
  promotion rules require a zero-diagnostic eligible case before any such change, and none exists.
  `pnpm test:consumer` (SPEC-001's required gate) is unmodified and remains failing on AC2, as required.
