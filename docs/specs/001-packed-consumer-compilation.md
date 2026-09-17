# SPEC-001: Packed consumer compilation baseline

- Status: Ready — **not implemented in the Astra documentation run**
- Baseline: `9d2635e`; recheck production-source drift before starting
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
