# Server Component hydration budgets (0.11.0 candidate)

## Scope and starting point

Starting synchronized `origin/main` SHA: `b69e2eec5bf0ba39f322e03143978ab892fba8a2`.
Feature branch: `feat/server-components-hydration-budgets-v011`.
Package version at start: `@strata-sc/server-components` 0.10.0. The tested fixture tuple is Node
22.23.1, Angular core/common/compiler/platform-browser/platform-server/router 22.2.3, Analog platform
and Angular Vite plugin 2.7.2, Nitro 2.13.4, Vite 8.3.0, TypeScript 6.0.3, pnpm 10.30.1, and
Playwright 1.62.1. It is local evidence for this locked tuple, not a broad support declaration.

Before the change, an executable `planClientBoundaries` test showed that 256 individually valid v1
boundaries were all accepted for one host. This characterizes unbounded aggregate preflight input;
it is not evidence of a demonstrated exploit or a measured browser failure. The baseline test ran
before replacing its assertion with the new threshold cases.

## Contract

One Server Component host may own at most 128 client boundaries and at most 1,048,576 aggregate
UTF-8 bytes in the `data-strata-props` attribute values. The existing 65,536-byte per-boundary limit
still applies independently. The limits are browser preflight safeguards; they do not constrain SSR
rendering or provide an SSR response-size guarantee.

The browser's owned set is the output of `discoverBoundaries`: any element carrying a client,
protocol or props attribute, except descendants nested under another boundary. Angular-owned
`@defer` descendants and boundaries owned by sibling Server Component hosts are outside that set.
The existing all-or-nothing flow is preserved: the complete discovery list is budget checked and
validated before a component is created. A refusal leaves SSR nodes in place, attaches no views,
marks no boundaries hydrated, and does not change sibling host behavior.

UTF-8 accounting scans the serialized attribute text as Unicode code points, including four-byte
surrogate pairs, without allocating a second encoded payload. Missing attributes add zero bytes and
are rejected by the existing metadata validation. Empty attributes add zero bytes and continue to
ordinary JSON/protocol validation. Error category `resource-limit` reports only the safe applicable
limit; no payload data is included. The existing ErrorHandler path receives the thrown
`StrataBoundaryError`, and the existing observer reports one `preflight-refused` event with zero
committed boundaries. Resource refusal is not build skew and does not invoke skew recovery.

Protocol v1/v2 parsing and writer contracts are unchanged. Within-budget build identity validation
continues through existing `checkBuildIdentity` logic. Existing nested-object and array budgets are
independent.

## Limit rationale and evidence state

The initial proposed limits are retained: 128 boundaries is twice the largest 64-boundary case
requested for evaluation, and the aggregate 1 MiB permits sixteen individually maximum-sized
payloads. The repository fixtures contain small ordinary compositions (including existing fixtures
with a few sibling islands); repository search found 41 textual `[strataClient]` mentions across the
three app trees, including docs/comments and distinct hosts, not a runtime maximum census. These
values have deterministic boundary evidence but have not been validated by a representative
production workload or measured browser performance profile.

## Qualification ledger

| Evidence                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline aggregate behavior                  | Planner accepted 256 valid boundaries; package suite run before implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Exact count boundary and 129 refusal         | Unit tests pass at 128 and 129. Chromium fixture refuses 129 owned boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Exact aggregate limit and +1 byte            | Unit tests pass at 1 MiB and 1 MiB + 1. Chromium supplies 17 individually valid v1 payloads totaling exactly 1 MiB + 1 byte.                                                                                                                                                                                                                                                                                                                                                                                             |
| UTF-8 ASCII, Unicode, emoji, escaped JSON    | Counter tests cover ASCII, multibyte Unicode, emoji and escaped serialized JSON text.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Node production / Chromium                   | `pnpm test:server-component-failures` passes with both budget refusals. Host B stays inert; captured SSR nodes remain, no B island is created/attached, one original Strata error is reported, and hosts A/C remain interactive.                                                                                                                                                                                                                                                                                         |
| Analog Vite development                      | Existing `pnpm test:server-component-dev` passes, but it does not exercise an over-budget host.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Local Cloudflare Pages/workerd               | The same failure harness passes both budget cases on local workerd. `pnpm test:server-components:cloudflare` passes on rerun. This is not a public deployment.                                                                                                                                                                                                                                                                                                                                                           |
| Nested ownership and sibling independence    | One button inside an owned boundary carries nested Strata attributes; its host still reports 3 owned boundaries and all 3 hosts commit.                                                                                                                                                                                                                                                                                                                                                                                  |
| Observer and ErrorHandler                    | One `preflight-refused`/`resource-limit` event with discovered count 129 or 17 and committed count 0; one ErrorHandler `StrataBoundaryError`; synthetic payload canary absent from errors, console and observations.                                                                                                                                                                                                                                                                                                     |
| Deployment skew / protocol v1-v2             | Existing skew and package unit suites pass; browser byte overflow uses valid v1 payloads. v2 parsing remains covered by package tests.                                                                                                                                                                                                                                                                                                                                                                                   |
| Packed consumer                              | `pnpm test:server-component-package-consumer` passes with the real 0.10.0 tarball installed outside the workspace. It checks TS 5.9.2 and 6 with strict declarations/`skipLibCheck: false`, Node SSR/hydration, and local workerd. Both packed Node and workerd browser fixtures refuse 129 owned boundaries with one safe event, zero islands, preserved SSR DOM and one ErrorHandler report. The package manifest remains 0.10.0 until release automation applies the Changeset.                                       |
| Asset/server bundle/performance measurements | No comparable before/after benchmark or browser heap result collected. No latency or size guarantee is claimed. New work is O(n) in discovered owned boundaries plus payload byte scanning.                                                                                                                                                                                                                                                                                                                              |
| Release workflow and issue #117              | `.github/workflows/release.yml` uses `workflow_run` for CI completion, checks the trusted default-branch authorizer, requires the exact run's successful `Verify` and current main SHA, and rechecks before Changesets. `verify-run.test.ts` covers failed, cancelled, pending, missing and duplicate Verify jobs; release tests pass (50). npm provenance and latest/next policy remain intact. GitHub reports issue #117 still open and pending Version Packages PR #146 still exists for the Analog 0.11.0 Changeset. |
| Hosted GitHub Actions                        | No feature-branch runs yet. The GitHub connector returned no runs for the main SHA (its workflow-run lookup filters to PR runs); `gh` could not reach `api.github.com`. Live same-SHA main Verify-to-Release evidence remains unavailable.                                                                                                                                                                                                                                                                               |
| Deployed qualification                       | Not run; no deployed qualification claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The full repo `pnpm build`, `pnpm typecheck`, `pnpm test` (including release and performance-tool
tests), `pnpm lint`, and `pnpm format:check` pass. Lint retains two existing import-order warnings
outside this change. Relevant Node/workerd Server Components checks, `@defer`, navigation, failure
recovery, deployment skew, server-only, security, request context, authorization, SSR response,
Vite dev, optimized deps, www/Relay dogfood, Cloudflare www build, packed Server Components consumer,
and full-stack packed consumer pass. `pnpm test:analog` has 2/113 recorded-baseline mismatches in
G2 build and production classification (expected A/C, observed B); its generated report was
restored because that file is outside this feature. The Analog route-registration benchmark command
ran and reported medians of 0.031 ms (1 route), 0.386 ms (100), and 0.940 ms (400); these are not
hydration timings.

Remaining limitations: the specifically budgeted route was not separately exercised through the
Analog dev server, despite the general dev suite passing. Timing series for 1, 8, 32 and 128
boundaries and a browser heap measurement are missing. Budgets are enforced in the browser after SSR
markup exists; no SSR writer bound is introduced. Frozen install and npm dry-run commands could not
complete because `registry.npmjs.org` was unreachable; the pinned Entwine 0.5.1 CLI is not installed
locally and network access prevented installing it, so `entwine check/build` remain unverified.
Existing navigation limitations, experimental protocol status, and M4/M5 release gates are
unchanged. This candidate does not certify M4 or Strata 1.0.
