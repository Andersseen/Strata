---
type: research
---

# RC0 publication and published qualification

Started 2026-11-27. It follows the [final RC0 qualification](rc0-production-requalification.md#final-rc0-qualification-2026-11-26)
and the RC entry (#202). This report records what stood between the entered tree and a published
`1.0.0-rc.0`, the corrected candidate, and its requalification. The process is
[SPEC-004](../specs/004-first-release-candidate.md), and the evidence is in
[`tools/release/rc-evidence.json`](../../tools/release/rc-evidence.json).

## Identities

These SHAs serve different purposes. Do not substitute one for another.

| Identity                           | Value                                      | Purpose                                                        |
| ---------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Original authorized candidate      | `e030175238efdee85ae7c443c4bf48970ff364bc` | the pre-phase GO of 2026-11-26 (#201); superseded              |
| Corrected candidate                | `97d4029866218c61ac606f0f4196cb0766bb5117` | merge of #206; the code the RC is published from               |
| Historical baseline harness        | `4888fe6cfa6ece91901f80b243f66fcbd3358b22` | qualified the published 0.x baseline; unchanged                |
| Historical baseline frozen id      | `e04b7bb1180795f3`                         | core 0.2.2, analog 0.13.0, server-components 0.17.0; unchanged |
| RC publishing SHA                  | pending                                    | the Version Packages merge Release publishes from              |
| Published RC harness and frozen id | pending                                    | the merged harness that freezes and qualifies the npm tuple    |

## Publication was blocked by two prerelease defects

Main at `246510d` (after #202) was in Changesets pre mode `{ "mode": "pre", "tag": "rc" }`. Release opened
Version Packages #203: eight files, the three manifests and changelogs at `1.0.0-rc.0`, and the two consumed
Changesets. Its diff was versioning only.

**Why its checks showed `action_required`.** The three runs (CI 45874377851, Registry verification
45874377646, Entwine 45874377841) were triggered by `github-actions[bot]`. The repository's fork-PR approval
policy is `first_time_contributors`, and the bot counts as one, so the runs stopped before scheduling any job.
Zero jobs is not a pass. The runs were approved through the approval endpoint, with no change to repository
policy or branch protection, and every regenerated Version Packages head needs the same approval.

**Result.** Registry verification and Entwine passed. CI failed aggregate **Verify** in five jobs, and Release
only authorizes a successful main Verify, so merging #203 could never have published.

| Defect | Location                                                  | Failure                                                                                                             |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1     | `packages/server-components/src/package-boundary.test.ts` | manifest policy `^\d+\.\d+\.\d+(-next\.\d+)?$`; SPEC-004 enters pre mode with the `rc` tag                          |
| D2     | `tools/release/lib/packages.ts` (`inspectPackedPackage`)  | refuses every prerelease: `version "1.0.0-rc.0" is not a released semver version`, in all four packed-consumer jobs |

D2 would also have failed every post-publication registry and frozen qualification, because those runners
inspect the tarballs they download. Neither defect is in package runtime code, and the publishing gate on #203
(`pnpm release:rc:check --phase=pre --publishing`) printed **GO**.

The pre-phase rehearsal missed D2 because it installed the rehearsed tarballs without running the inspector.

## Correction

#204, re-landed unchanged as #206:

- **D1.** One version-policy constant, plus a test that the tag in `.changeset/pre.json` matches it, so a mismatch
  fails the entry itself.
- **D2.** The inspector accepts `X.Y.Z-rc.N` and still refuses `0.0.0`, `-stage`, `-next.N`, `-beta.N` and
  malformed prereleases. The rehearsal now runs the inspector on the tarballs it versions, and restoring the old
  inspector makes it report `FAIL` for all three.
- **Pipeline acceptance.** The D2 fix changes `tools/release/`, which resets `release-pipeline-observed`. In pre
  mode that row could only be re-earned by the RC it blocks. By the maintainer's decision, the row may name one
  maintainer-merged pull request as the pipeline's only change since the observed publish. The gate proves that
  the pull request was merged by the maintainer, that its base pipeline equals the observed one, and that the
  candidate's pipeline equals its merge
  ([SPEC-004](../specs/004-first-release-candidate.md#accepting-a-release-pipeline-change)).
- **Harness.** Simultaneous local workerd instances shared one `--persist-to` directory, and one died at startup
  with `SQLITE_BUSY` (1 in 6 runs under host load, in the mandatory unit-test job). Each instance now has its own
  state directory. No timeout, retry or assertion was relaxed, and afterwards 12 of 12 runs passed under the same
  load.

**Verification before merge.** On the versioned tree (#203 head `5def897` with D1 and D2 applied), all 14 commands
of the five failed jobs pass locally. #204's hosted CI (run 45966004163) passed every job, and so did #206's
(run 45978891921) on a tree byte-identical to it.

## Incident: unreviewed commits on main, and the re-land

Before #204 merged, four local work-in-progress commits reached `main` without a pull request (`c83e4fa`,
`dc0d5ef`, `8df5871`, `12af5a1`). The branch they were on had been created tracking `origin/main`, and a push
from the shared checkout sent them there. #204 then merged on top of them (`c0d9bf7`).

**Consequences.** Main CI failed on the generated-docs check, so neither the website nor Release deployed
anything. One commit touched `tools/release/lib/upgrade-pair.test.ts`, so #204's base no longer had the observed
pipeline, and the new acceptance check refused it.

**Repair, with no force push.**

1. #205 restored the tree exactly to `246510d` (merge `508bb81`).
2. #206 re-landed #204's four commits unchanged (merge `97d4029`, first parent `508bb81`).

#206 is therefore the single accepted pipeline change, and `97d4029` is the corrected candidate. The maintainer
authorized the merges of #204, #205 and #206 in the working session. The work-in-progress changes return later
through a reviewed pull request. Branches are now created without an upstream.

**Release refused to act on any of it.** In the authorizer, Release 45979897453 stopped with
`Release blocked: source CI run did not complete successfully` (the failed CI of `c0d9bf7`). Release
45982468969, triggered while main was moving, stopped with
`Release blocked: source commit is no longer the current main head`. That is a hosted observation of the
stale-main transition of issue #117. The cancelled and pending transitions are still unobserved. The candidate's
own Release run
(45982887724) passed authorization and regenerated Version Packages #203 at `b1ae687`, again eight
versioning-only files.

## Requalification of the corrected candidate

The nine candidate-bound rows, taken again on `97d4029`. The three baseline rows are bound to the unchanged
baseline harness and stay valid.

| Row                                                                                                                                            | Run                                                            | Result            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------- |
| `ci-verify`                                                                                                                                    | CI push 45981200362                                            | Verify success    |
| `release-pipeline-observed`                                                                                                                    | Release 45694359277 (analog 0.13.0) with `pipelineChange` #206 | see the gate      |
| `deployed-source-packed`                                                                                                                       | Cloudflare packed 45981222817                                  | success           |
| `island-interaction`, `performance-scaling`, `ssr-duplicate-install`, `node-production-source`, `adversarial-security`, `prerelease-rehearsal` | Extended `suite=all`, `islands=both` 45981218495               | every job success |
| `support-contract-review`                                                                                                                      | this pull request, merged by the maintainer                    | #207              |

With this ledger, `pnpm release:rc:check --phase=pre` re-reads every row live, and its only blocker is `support-contract-review: pull request 207 was not merged by Andersseen`: the decision this pull request records. Version Packages #203 at `b1ae687` (the candidate plus versioning only) passed CI 45983116849 after its bot-triggered runs were approved.
