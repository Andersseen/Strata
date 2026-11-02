# Release pipeline reliability: a green Release run that published nothing

Date: 2026-11-02  
Starting SHA: `6beb420726f32ac32276ac7b177c1492856332b4` (`origin/main`, after PR #162)  
Branch: `fix/release-pipeline-reliability`

## Verdict first

**FIXED LOCALLY, HOSTED TRANSITIONS NOT YET OBSERVED.** The workflow can no longer succeed while a public
package's manifest version is absent from npm. Nothing was published from this branch. `@strata-sc/server-components`
0.14.0 is still **unpublished**; it can only be published by the automated Release workflow after this change is
merged and the existing exact-SHA authorization passes. Issue #117 stays open; this is not a Strata 1.0 claim.

## Incident evidence

| Fact                             | Value                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Manifests                        | core 0.2.2, analog 0.12.0, server-components 0.14.0, h3 private (excluded)                     |
| npm `core` / `analog` versions   | 0.2.2 / 0.12.0 present (`latest` = manifest)                                                   |
| npm `server-components` versions | latest published 0.13.0; **0.14.0 absent**                                                     |
| Version Packages PR              | #158 merged                                                                                    |
| Release runs                     | `41425569177`, `41440296534`: both `success`; log: `All changesets are empty. Not creating PR` |
| GitHub Release / tag             | latest server-components release and tag are 0.13.0                                            |
| Separate, out of scope           | Extended run `41440983466` (performance benchmark, `@standard-schema/spec` in Analog arms)     |

## Root cause

Both, in combination.

1. **Changesets behavior.** `changesets/action@v2` runs its publish script only when no Changeset file exists. With
   only empty Changesets (qualification-only work, `---\n---`), it reports `hasChangesets=true`, logs
   "All changesets are empty. Not creating PR", does not publish, and exits successfully. Pending-but-empty files
   therefore block publishing of an already-versioned manifest (case B, and D when the nonempty ones are gone).
2. **Our workflow conditions.** The dist-tag alignment and the registry-consumer gate were keyed on
   `hasChangesets == 'false'`, so they were skipped too. No step reconciled manifests against npm, so every step
   was green or skipped and the run was green.

Behavior matrix (action semantics vs. the new classifier):

| Case                                       | `changesets/action` alone                   | New state                   |
| ------------------------------------------ | ------------------------------------------- | --------------------------- |
| A no Changesets, unpublished version       | publishes                                   | `PUBLISH_REQUIRED`          |
| B only empty Changesets, unpublished       | **skips publish, green**                    | `PUBLISH_REQUIRED`          |
| C nonempty Changesets                      | Version Packages PR                         | `VERSION_REQUIRED`          |
| D empty + nonempty                         | Version Packages PR                         | `VERSION_REQUIRED`          |
| E merged version PR, unpublished manifests | as A or B depending on leftover empty files | `PUBLISH_REQUIRED`          |
| F fully published                          | no-op                                       | `ALREADY_PUBLISHED`         |
| G partially published                      | publishes missing (when it runs)            | `PUBLISH_REQUIRED`, partial |
| registry timeout / 401 / 5xx / bad JSON    | not consulted                               | `BLOCKED`                   |

Reproduced deterministically (no npm publish) by the first case in `release-state.test.ts`, which pins the action's
gating rule and shows the classifier disagrees on empty-only Changesets.

## Implementation

- `tools/release/lib/registry.ts`: read-only abbreviated-packument reader. Only HTTP 404 is "missing"; timeouts,
  401/403/429/5xx, network errors and malformed or mismatched metadata throw.
- `tools/release/lib/release-state.ts`: `classifyRelease` (state + published/unpublished sets, internal dependency
  check, placeholder-version guard, private packages ignored), Changeset counting, and `verifyPublication`.
- `tools/release/release-state.ts` (`pnpm release:state`, `pnpm release:verify`): CLI for the workflow, writes step
  outputs and the job summary; `classify` fails on `BLOCKED`.
- `.github/workflows/release.yml`: classify → authorization recheck → `changesets/action` (only for
  `VERSION_REQUIRED` / `PUBLISH_REQUIRED`) → dist-tag sync → registry verification → Server Components registry
  consumer. On `PUBLISH_REQUIRED` the empty Changesets are deleted from the ephemeral checkout only (never committed),
  so the existing action path keeps its tags, GitHub Releases, provenance and `latest`/`next` behavior; no parallel
  publisher was introduced.

Verification (`release:verify`) requires every public package at its exact manifest version on npm, internal
dependency ranges equal to the local version, and dist-tags that satisfy `planDistTags` (ADR-005). A publish that
does nothing fails here because only the registry can satisfy it. Missing git tags or GitHub Releases for the
packages published by the run are annotated as warnings (not failures: older packages have no per-package releases).
The consumer gate (`pnpm test:server-component-registry-consumer`) remains a separate step and receives the manifest
version of the authorized checkout.

## Security properties retained

- Trigger unchanged: `workflow_run` of `CI` on `main`; `authorize` job runs the default-branch authorizer, unchanged
  (`verify-run.ts` and its tests are untouched): successful push-to-main run, own aggregate `Verify` completed
  successfully, SHA equals current main.
- The second authorization check still runs immediately before the only mutating step (`changesets/action`); the
  classification before it is read-only and holds no secrets. Mutating npm steps after it (dist-tag sync) act on the
  same checked-out SHA; staleness there can only align tags for that version and never publishes.
- Permissions and `NPM_TOKEN` scope are unchanged; the checkout is the authorized SHA; no PR code runs with
  credentials; `@strata-sc/h3` is private and excluded.

## Regression cases (`pnpm test:release`, +28 tests, 102 total)

Nonempty Changesets → Version PR path without registry access; empty-only → publish; none + unpublished → publish;
none + published → explicit no-op; partial release resumes only missing packages; 404 vs timeout / auth / malformed
metadata (BLOCKED); private package never queried; dependency mismatch and `0.0.0` block; repeated runs idempotent;
registry reader status mapping; verification of a no-op publish, wrong dependency, wrong `latest`, prerelease
`next`, unreadable registry; empty-Changeset deletion in a temp directory. Existing authorization tests
(failed/cancelled/pending Verify, stale main, non-main/PR source) are unchanged.

## Verification results

Local: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm format:check`, `pnpm test:release`
PASS; `pnpm lint` 0 errors (warnings pre-existing in other files); `pnpm release:state` against the live registry
returns `PUBLISH_REQUIRED` (server-components 0.14.0, 2 published). Hosted results are in the PR.

## Remaining risks

- Live `workflow_run` transitions (including the first real `PUBLISH_REQUIRED` publish and the consumer gate for
  0.14.0) are unobserved; #117 stays open.
- Deleting empty Changesets relies on `changesets/action` publishing when none exist; if the action changes, the
  verify step still fails the run instead of passing silently.
- Registry metadata can lag briefly after a publish; a verify failure then needs a re-run (idempotent), not a republish.
- A mixed state (nonempty Changesets plus an unpublished manifest) goes the Version PR route first; the unpublished
  version publishes on the following run.
- Tag/Release checks warn only. Provenance is not asserted by `release:verify`.
