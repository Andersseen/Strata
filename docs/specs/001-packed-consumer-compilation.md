# SPEC-001: Packed consumer compilation baseline

- Status: **Blocked** — implemented and executed; a required acceptance criterion fails on a
  pinned-dependency defect external to `@strata/core`/`@strata/h3`. See
  [Implementation result](#implementation-result).
- Baseline: `9d2635e`; implemented against `a7fe88c` (no `packages/` drift between the two — only
  documentation commits landed in between; reverified before implementation started)
- Milestone: M1
- Author/reviewer: Astra; implementer: a separate implementation agent
- Depends on: existing core metadata and H3 adapter; no unreleased future capability
- Decisions: ADR-001, ADR-002
- Risks: R01, R16; supplies limited evidence for R07/R14

## Context

`@strata/core` and `@strata/h3` already implement GET controllers and pass 34 tests. Those tests run
inside a workspace with private TypeScript pre-transform plugins. Package exports point to `dist`,
and the adapter consumes core via `workspace:*`. No test installs packed packages in an external
project or compiles user-written decorators without those hidden conveniences.

## Problem

A successful package build does not establish that a user can compile a controller and execute it
against the shipped API. We need a reproducible consumer baseline before selecting a public compiler
plugin or debugging Angular/Analog's more complex pipeline.

## Goals

- Verify shipped exports, declarations, dependency rewriting and metadata initialization externally.
- Prove one executable standard-decorator recipe using TypeScript first, followed by Vite bundling.
- Characterize unmodified Vite against the same original TypeScript source and record whether it
  lowers decorators correctly on the exact pinned version.
- Add a reusable test command and CI evidence without changing production behavior.

## Non-goals

No HTTP features, metadata fixes, DI, Angular/Analog application, server components, public compiler
plugin, new published package or H3 major migration. This is consumer qualification tooling.

## Public API impact

None. Preserve all existing exported symbols, signatures, package versions and runtime semantics.
Do not add a transform export or promise a supported Vite plugin. Add one root development command,
`test:consumer`, that runs the complete qualification and exits nonzero on required failures.

## Architecture

### Owned file areas

Use `tests/consumer/` for fixture source/configuration, `tools/consumer/` for the runner, and a report
at `docs/research/consumer-compilation.md` containing measured results. Root `package.json` may gain
the command, and `.github/workflows/ci.yml` may gain its invocation after building packages. A
lockfile change is allowed only for genuinely required test tooling; prefer existing tools. No
changes to production source, package manifests, private package transforms or workspace globs.

The runner creates a temporary directory **outside the workspace**, cleans it on success, and reports
its path on failure for inspection. Copy fixture inputs, do not symlink workspace package sources.
Retain concise logs/reports for CI; do not commit generated packages, dependency trees or bundles.

### Fixed experiment

1. Build core and adapter from the checkout and pack both into tarballs using pnpm. Record their
   contents and digests. Verify the adapter's packed dependency no longer contains `workspace:`.
2. Create an ESM consumer in the temporary directory. Install both tarballs with TypeScript 6.0.3,
   Vite 8.3.0, H3 2.0.1-rc.32 and `@types/node` 22.20.3. Use a consumer-only override to resolve the adapter's core dependency
   to that same local core tarball if needed; do not rely on a published `@strata/core@0.0.0` existing.
   Assert exactly one resolved core package and the intended H3 version in the consumer graph.
3. The consumer imports **only package public entry points**. Its authored TypeScript defines one
   `@Controller('/consumer')` with a synchronous root GET and an asynchronous `/async` GET, accessing
   instance state so invocation binding is exercised. It reads the definition, registers routes on
   `new H3()`, and verifies a native `/native` route still works. No request API or inheritance cases.
4. Compile that source with consumer-local TypeScript: ESM/NodeNext, target ES2023, strict checks,
   libraries `ES2023`, `DOM`, `DOM.Iterable` and `esnext.decorators`, plus Node types, with legacy
   decorators and emitted type metadata disabled. Do not extend
   repository tsconfigs or suppress declaration errors with `skipLibCheck`. Execute the emitted
   entry in a fresh Node process without TS loaders.
5. Bundle the **TypeScript-emitted JavaScript** with consumer-local Vite as an SSR entry, target
   ES2023 and ESM output. Execute that output in another fresh Node process and rerun the same
   public behavior assertions. This two-stage recipe is the reference experiment, not a final DX
   choice. Externalized runtime dependencies must resolve from the isolated consumer installation.
6. In a separate output directory, run stock Vite directly on the original consumer TypeScript with
   no decorator plugin or pre-compilation. Capture build status, JavaScript parse/execution result,
   metadata and HTTP outcome. Record a precise result: works, build fails, or emitted runtime fails.
   Do not force an expected failure if current Vite actually succeeds. This arm is characterization;
   it cannot make a failing reference recipe count as passing.
7. Save a compact result with versions, commands, output paths, digest, diagnostics and conclusions.
   Compare the direct-Vite and reference paths. Propose follow-up investigation, without choosing
   the eventual consumer compiler architecture.

Use H3's in-process request API; no listening port, deployment or external service is needed. Keep
the authored consumer source identical across arms. Assertions run against the public package
result, not internal metadata storage or a mock H3 application.

## Constraints

- No alias, `paths`, relative import or symlink to `packages/*/src` or internal build helpers.
- No `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`, custom Node loader,
  consumer-side metadata patch or manual `Symbol.metadata` initialization to mask package behavior.
- Verify the installed core import provides the symbol before decorated classes evaluate. Use an
  isolated process to test an already-present symbol remains unchanged; do not alter the host process.
- Do not change production packages to make this slice pass. If a real package defect is found,
  report a reproducible blocker to Astra and retain the failing evidence for a separate fix spec.
- A package-manager/network failure is an infrastructure failure, not evidence of decorator failure.
  Report it distinctly and do not swallow it as an expected characterization outcome.
- Fresh generation must remove prior outputs. No environment-specific absolute paths or credentials
  in committed artifacts. TypeScript/Vite commands must run from the consumer's own installation.

## Acceptance criteria

| ID  | Observable result                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 | Root `test:consumer` starts from built/packed current checkout, installs outside the workspace and records exact versions and tarball identities. It can build prerequisites itself, so documented invocation is sufficient. |
| AC2 | Packed contents expose importable public JavaScript and declarations. Consumer typecheck passes without source aliases or legacy metadata. Adapter dependency resolves to the same installed core.                           |
| AC3 | Reference TypeScript output runs in plain Node; public definition reports `/consumer`, two GET routes and their correct method names. Import-time initialization works and preserves a preexisting metadata symbol.          |
| AC4 | Both emitted TypeScript output and Vite-bundled reference output return expected JSON for sync/async controller routes and native route; instance state is accessible.                                                       |
| AC5 | Direct-Vite outcome is independently reported with stage-specific diagnostics. If it runs, it must pass the same assertions before being recorded as successful.                                                             |
| AC6 | Deliberately missing a tarball or corrupting an expected response causes runner failure; missing/empty outputs cannot pass. Direct-Vite expected limitations do not hide reference-arm failures.                             |
| AC7 | CI invokes the command with the repository's Node 22/pnpm setup. Documentation explains the temporary two-stage recipe and clearly excludes Angular/Analog compatibility claims.                                             |
| AC8 | Production source/API/package versions remain unchanged; result report maps each acceptance ID to evidence and flags any blocker or unrun remote check.                                                                      |

## Required tests

- AC1/AC2: tarball manifest/content assertions and isolated install/dependency-resolution assertions;
  consumer-local strict `tsc` validates public declarations.
- AC3: public metadata assertions in a fresh process plus symbol-preservation case. Do not reach into
  `context.metadata` private symbols; only inspect the standard global symbol and the public getter.
- AC4: H3 request status/body assertions for both compilation outputs, including async result and
  instance binding. Do not over-specify the provisional instance lifetime.
- AC5: capture direct-Vite compile and execution separately; parse executable output with Node and
  assert behavior. A string search for `@` alone is not an executable-output test.
- AC6: runner negative controls prove failures propagate; do not snapshot verbose tool diagnostics.
- AC7/AC8: review workflow invocation, generated report and changed-file scope.

Validation commands are `pnpm test:consumer`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
and formatting checks for changed files, using the repository's RTK prefix when required by local
instructions. Capture local outcomes and the PR's CI run; unavailable remote execution remains open.

## Compatibility concerns

Start on the repository's Node 22 line (audit used 22.23.0), pnpm 10.30.1, TypeScript 6.0.3, Vite
8.3.0 and H3 2.0.1-rc.32. Record the consumer's transitive Rolldown resolution; keep it 1.2.8 for
the baseline comparison using consumer-only constraints if necessary. Never silently test a newer
compiler/bundler and report it as the locked baseline.

This slice establishes one Node consumer recipe, not general Vite support, browser compatibility,
Cloudflare execution or Angular AOT coexistence. M2 must investigate those separately.

## Risks

R01/R16 are reduced by independent compilation and installation. R07 remains open because dev/HMR,
environment-specific transforms, virtual IDs and Angular compiler ordering are not exercised. R14
remains open because no Angular/Analog/Nitro tuple is installed. A valid report may expose a package
defect; do not redefine passing acceptance criteria to conceal it.

## Definition of Done

The implementation PR provides tooling/fixtures, required checks, CI wiring, measured report and an
AC evidence table. It contains no production changes. Tooling-only work requires no package
Changeset; explain that in the PR. Astra reviews the evidence, updates STATE/M1, and decides the next
spec. Mark this spec Accepted only when its required positive checks pass; an infrastructure or
package blocker keeps it Blocked/In review with evidence.

## Explicitly out of scope

Shipping the reference recipe as a public compiler plugin; deduplicating internal transforms;
adding verbs/input APIs; fixing inheritance or registration semantics; Angular DI; creating
`@strata/analog`, `@strata/compiler`, `@strata/vite` or any other package; production deployment;
implementing any Server Component or navigation feature. Astra does not execute this spec now.

## Implementation result

- Baseline `9d2635e` → implemented and executed against `a7fe88c` (`main`, clean tree). No drift in
  `packages/` between the two; only documentation commits (roadmap, `docs/`) landed in between.
- Full measured evidence: [docs/research/consumer-compilation.md](../research/consumer-compilation.md),
  regenerated by every `pnpm test:consumer` run.
- Changed files: `tests/consumer/fixture/**` (fixture source), `tools/consumer/**` (runner),
  `docs/research/consumer-compilation.md` (evidence), `package.json` (`test:consumer` script),
  `.github/workflows/ci.yml` (CI invocation after build), `eslint.config.js` (excludes the fixture —
  a deliberately foreign TypeScript project compiled by its own isolated tsc/Vite — and the plain-JS
  runner from this repo's type-aware lint project; no rule changed for existing source). No file
  under `packages/` changed.
- AC1, AC3, AC4, AC5, AC6, AC7, AC8: **Pass**, with reproducible command/diagnostic evidence in the
  report above.
- AC2: **Blocked**. Dependency rewriting (`workspace:*` → `0.0.0`) and single-core-copy resolution
  both pass, but consumer-local strict `tsc` does not cleanly typecheck under the pinned tuple
  (TypeScript 6.0.3, H3 `2.0.1-rc.32`, and the exact `lib` set this spec mandates:
  `ES2023`/`DOM`/`DOM.Iterable`/`esnext.decorators`). Every diagnostic originates from H3's own
  shipped `.d.mts` files, not from `@strata/core` or `@strata/h3`:
  1. `HTTPError.isError` is declared `static override`, assuming an ambient `Error.isError` static
     member that only exists via TypeScript's `esnext.error` lib — outside this spec's mandated lib
     set (`TS4113`).
  2. H3's root type entry unconditionally imports types from `crossws`, an optional peer dependency
     outside this spec's fixed install list (`TS2307`). Installing `crossws` as a diagnostic-only
     probe made this worse: it transitively requires `bun`, `cloudflare:workers` and
     `@cloudflare/workers-types` type packages that are not installed either.

  `skipLibCheck` would silence both, but this spec explicitly forbids using it to suppress
  declaration errors, so the failure is reported rather than routed around. Despite this, `tsc`
  still emits JavaScript for the reference recipe (TypeScript's default `noEmitOnError: false`), and
  that emitted output — and its Vite-bundled form — runs correctly and passes every runtime
  assertion (AC3/AC4), so R01 (decorator lowering) has strong positive evidence independent of this
  blocker.

- Characterization arm (no reference-recipe deviation): stock Vite, run directly on the original
  consumer TypeScript with no decorator plugin, builds successfully but emits un-lowered
  `@decorator` syntax; executing that output in Node fails with `SyntaxError: Invalid or unexpected
token`. This confirms — rather than assumes — the private `standardDecorators()` transform
  documented in [STATE](../STATE.md) remains necessary for any consumer, and this failure does not
  affect the reference-recipe verdict (AC5).
- Blocker for a separate fix spec: this pinned tuple (H3 `2.0.1-rc.32` + TypeScript `6.0.3` + the
  lib set this spec mandates) cannot pass a clean strict consumer typecheck without either relaxing
  the mandated `lib` set (adding `esnext.error`) or accepting an unresolved `crossws` peer type
  import — both are outside this spec's fixed experiment and require an explicit decision, not a
  silent tooling change.
- Changesets: none generated. No production/package behavior changed; this is tooling-only, per
  [COMPATIBILITY](../COMPATIBILITY.md)'s pre-1.0 Changeset rule ("when package behavior changes").
- Unrun/remote: this PR's own CI run (`pnpm test:consumer` inside `.github/workflows/ci.yml`) is not
  independently verified here; only local execution on Node `v22.23.0` / pnpm `10.30.1` is evidence
  so far. CI is expected to fail on the same AC2 blocker until Astra decides how to resolve it.
