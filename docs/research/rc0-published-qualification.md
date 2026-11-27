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

| Identity                           | Value                                                          | Purpose                                                                   |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Original authorized candidate      | `e030175238efdee85ae7c443c4bf48970ff364bc`                     | the pre-phase GO of 2026-11-26 (#201); superseded                         |
| Corrected candidate                | `97d4029866218c61ac606f0f4196cb0766bb5117`                     | merge of #206; the code the RC is published from                          |
| Historical baseline harness        | `4888fe6cfa6ece91901f80b243f66fcbd3358b22`                     | qualified the published 0.x baseline; unchanged                           |
| Historical baseline frozen id      | `e04b7bb1180795f3`                                             | core 0.2.2, analog 0.13.0, server-components 0.17.0; unchanged            |
| RC publishing SHA                  | `3f6cd0b1a7a14154a29fe6b1711288b0264e93f5`                     | merge of Version Packages #203; Release run 46026262608 published from it |
| Published RC harness and frozen id | `857fa821254f9d99c97f9109e3def33847807bc0`, `2fc5213b0a046580` | merge of #208; the main-bound post-phase runs are taken on it             |

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

## Publication (2026-11-27)

The maintainer merged decision PR #207 (`668abea`). There, `pnpm release:rc:check --phase=pre` printed **GO**.
Release regenerated Version Packages #203 at `3747f04` (eight versioning-only files), and its bot-triggered runs
were approved. All 14 checks passed, and the publishing gate (`--phase=pre --publishing`) printed **GO** on that
tree. The maintainer authorized the merge of #203 (`3f6cd0b`). Main CI 46024826137 succeeded on it, and Release
run **46026262608** passed every step on `3f6cd0b`: exact-CI authorization, `Authorize release candidate` (the RC
gate with `--publishing`), `Version PR or publish to npm`, `Align npm dist-tags`, `Verify npm registry, tags and
GitHub Releases`, and `Verify @strata-sc/server-components from the npm registry`.

Read back from registry.npmjs.org:

| Package                        | Version    | SHA-512 integrity                                                                                 | Provenance |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------- | ---------- |
| `@strata-sc/core`              | 1.0.0-rc.0 | `sha512-bWViceY3fIFrUDPwAHJkIUTr/PfYAWzK3Qy1nzA3ihh1FGlXcxLcGbP5lGDd8A6O5TjVYsmG8KWN4M/9/tFEMA==` | yes        |
| `@strata-sc/analog`            | 1.0.0-rc.0 | `sha512-NgcmdxJTzuUY2UUNhXDo1hviRwQ/e6RllWClLfYA+pxgPIGPTd6dHf0PRNm+PROllfP+NU5h2XOO00ovUR7LFw==` | yes        |
| `@strata-sc/server-components` | 1.0.0-rc.0 | `sha512-WuZYJsed9FWj7eB9QdsXvngtwMciOvw65IOb/fb+2C3bLRnzrMpzfW/PFZT2CzVgDAJoJCxFc0N2lk1z0TyyHA==` | yes        |

| Dist-tag | core       | analog     | server-components |
| -------- | ---------- | ---------- | ----------------- |
| `latest` | 0.2.2      | 0.13.0     | 0.17.0            |
| `next`   | 1.0.0-rc.0 | 1.0.0-rc.0 | 1.0.0-rc.0        |
| `rc`     | 1.0.0-rc.0 | 1.0.0-rc.0 | 1.0.0-rc.0        |

`rc` is the Changesets pre-mode tag; `sync-dist-tags` moved `next` to the RC as ADR-005 requires, and `latest`
did not move. `@strata-sc/analog` depends on `@strata-sc/core` `1.0.0-rc.0` exactly and on
`@standard-schema/spec` `1.1.0`. The server-components peers are `@angular/*` `^22.1.7`, `typescript`
`^5.9.0 || ^6.0.0`, and `vite` `>=8.3.0 <9`. No stable `1.0.0` exists, and `@strata-sc/h3` is not on npm. The
GitHub Releases for the three packages are marked pre-release.

## Post-phase qualification and verdict

The frozen RC `2fc5213b0a046580` was captured from npm by `test:full-stack-registry-consumer` (0 failing
checks), with every integrity equal to npm's, and reproduced by `test:full-stack-frozen-candidate` (0 failing).
Harness #208 merged as `857fa82`. Every run below is on `main` at that SHA and dispatched there; branch
pre-checks (Cloudflare registry 46029485059, upgrade-rollback 46030111912) passed too, but do not count.

| Row                   | Evidence                                                                              | Result                                                         |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `rc-publication`      | Release 46026262608 on `3f6cd0b`                                                      | published, tags aligned, registry and GitHub Releases verified |
| `rc-frozen`           | Extended 46057150465, "Frozen release candidate"                                      | success                                                        |
| `rc-node-production`  | Extended 46057150465, "Node production process (frozen candidate)"                    | success                                                        |
| `rc-deployed`         | Cloudflare `registry` 46057154593, installed versions 1.0.0-rc.0                      | 0 failing checks                                               |
| `rc-upgrade-rollback` | Cloudflare `upgrade-rollback` 46057670068, A = 0.2.2/0.13.0/0.17.0, B = 1.0.0-rc.0 ×3 | deployed upgrade, stale clients, retained rollback; 0 failing  |

**`pnpm release:rc:check --phase=post`: VERDICT GO**, re-read live from GitHub, npm and git on the ledger
branch. The accepted GA requirements (`real-application`, `persistent-node`, `cloudflare-cold-start-memory`,
`issue-117-transitions`) stay NOT RUN. They are accepted for an RC, never for GA.

**One Extended job failed and was re-run.** In 46057150465, "Full-stack performance baseline" failed in its
three-island arm. `npm install` got `404 Not Found` for `https://registry.npmjs.org/@babel/helpers/-/helpers-8.1.4.tgz`,
although the one-island arm of the same job had installed. Minutes later that tarball answered HTTP 200 and its
metadata listed it, so this was a transient registry failure on an existing artifact. No post-phase row binds that
job, and the frozen RC lock does not pin that tarball. Only the failed job was re-run: attempt 2 passed, with the one- and three-island profiles and the size budgets, and the whole run now reads `success`. A rerun is recorded as such, not as proof that a defect was fixed.

**Not measured, and not invented.** There is no persistent Node deployment: the Node evidence is a production
process on hosted Linux and locally. Cloudflare exposes no reliable isolate cold-start or memory measurement for
this project.

## Verification

Local (macOS, Node 22.23.1), sequential:

| Command                                                                                              | Result                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| `format:check`, `lint`, `typecheck`                                                                  | pass                            |
| `test:release` (317), `test:performance-tools`, `test:ci`                                            | pass                            |
| versioned tree of #203 with the fixes: build, unit gates and the 14 commands of the five failed jobs | pass                            |
| `test:full-stack-registry-consumer` (capture of 1.0.0-rc.0)                                          | PASS, 0 failing                 |
| `test:full-stack-frozen-candidate`                                                                   | PASS, 0 failing                 |
| `test:full-stack-registry-upgrade-rollback` (0.x → RC)                                               | PASS, 0 failing, 1,486 ok       |
| `test:node-production:frozen`                                                                        | PASS, RSS 210,720 → 216,784 KiB |
| `release:rc:rehearse`                                                                                | all checks ok                   |
| `release:rc:check --phase=pre --publishing` on #203 (`5def897`, `3747f04`)                           | GO                              |
| `release:rc:check --phase=pre` on `668abea`                                                          | GO                              |
| `release:rc:check --phase=post`                                                                      | GO                              |

Not run locally, with the hosted run that covers each instead: `test:node-production` (source-packed: Extended
45981218495 and 46057150465), `test:full-stack-adversarial-security` (Extended, both runs), the performance
profiles (Extended), the `www:*` and `relay:*` suites and `test:www:server-components` / `test:relay:server-components`
(CI "Website and Relay" on #204, #206, #207 and #208), and the Server Component and Analog contract scripts (CI on
the same PRs). The private H3 v2 adapter's strict-type blocker (SPEC-002) is unchanged and outside this release.

Hosted: CI on #204 (45966004163), #206 (45978891921), #203 (`b1ae687` 45983116849; `3747f04` 46023455446), main
`97d4029` (45981200362), `668abea` (46021728610) and `3f6cd0b` (46024826137); Extended 45981218495 (candidate) and
46057150465 (harness); Cloudflare packed 45981222817, registry 46057154593, and upgrade-rollback 46057670068;
Release 46026262608.

## Prerelease-aware consumer coverage

Version-dependent fixture logic, audited for `1.0.0-rc.0`:

| Logic                            | File                                                                                | Result for `1.0.0-rc.0`                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Exact-version selector           | `tools/release/lib/registry-version.ts`                                             | accepts prereleases; unchanged                                                         |
| `/ssr` entry bridge (`< 0.15.0`) | `tools/server-components/lib/ssr-recipe-bridge.ts`                                  | not bridged: the installed `/ssr` entry is used                                        |
| `/ssr` 0.17.0 migration types    | same                                                                                | compiled                                                                               |
| S-1/S-2 analog contract          | `full-stack-consumer.ts`, `node-production.ts`, `full-stack-deployed-cloudflare.ts` | **defect**: a published tuple without the declarations passed with S-1 "not exercised" |

The S-1/S-2 detection was right for the pre-0.13.0 baseline, but it would have let a published RC that lost the
contract pass silently. Now the installed version decides: 0.13.0 or later, prereleases included, must declare
the contract, and only an older tuple may run without it. Version precedence is now semver-correct for
prereleases: `0.13.0-rc.0` predates `0.13.0`, and `1.0.0-rc.0` predates neither 0.15.0 nor 0.17.0.

Other contracts: keep-alive after an oversized body (`keepAliveAfter413`), both halves of the `/ssr` contract,
duplicate installations, client reference validation, hydration commit rollback, and build identity. All of them
run unconditionally in the published modes, so a prerelease cannot skip them.

## Upgrade pair

The default A/B pair was server-components 0.16.0 → 0.17.0 on core 0.2.2 / analog 0.13.0. It cannot establish
an upgrade to the RC, so the default is now:

| Arm | core       | analog     | server-components | Build id              |
| --- | ---------- | ---------- | ----------------- | --------------------- |
| A   | 0.2.2      | 0.13.0     | 0.17.0            | `upgrade-a-2026.11.6` |
| B   | 1.0.0-rc.0 | 1.0.0-rc.0 | 1.0.0-rc.0        | `upgrade-b-2026.11.7` |

One consumer source serves both arms, every non-Strata dependency must match in version and integrity, and the
build ids are deployment labels that contain no package version. The historical pair is still reproducible with
the `STRATA_UPGRADE_*` inputs. The hosted `upgrade-rollback` dispatch uses these defaults.

## External adoption checklist (RC0)

A synthetic fixture does not count. An adoption counts only when an application that exists for its own
purpose meets every item:

1. Installs `@strata-sc/core`, `@strata-sc/analog` and `@strata-sc/server-components` at exactly `1.0.0-rc.0`
   from npm, with a committed lockfile. No workspace link, tarball or `file:` dependency.
2. Runs on the supported tuple (Angular 22.2.7, Analog 2.9.7, router 2.8.1, Vite 8.3.8, Nitro 2.13.6,
   H3 1.15.11, TypeScript 6.0.3 or 5.9.2), or records each deviation as a finding.
3. Delivers actual application functionality that users or operators rely on, not a demo route.
4. Uses its own services, not Strata fixtures: repositories, domain logic, configuration.
5. Uses controllers for application behaviour: validated input, guards, explicit statuses, cleanup.
6. Uses Server Components for actual rendering, with server-only modules marked.
7. Has at least one meaningful interactive island (state, events, an API call), not a static badge.
8. Owns authentication and authorization: principal resolution, 401/403 before any read, tenant or user
   isolation where data is per-user.
9. Reads persistent data or an existing data source (database, CMS store, API), not in-memory constants.
10. Is deployed on a production-compatible target: Cloudflare Pages on the pinned settings, or a persistent
    Node 22 server.
11. Upgrades from its previous deployment and rolls back to the retained artifact, with a distinct `buildId`
    per deployment.
12. Returns developer feedback: setup time, what the documentation got wrong, unclear diagnostics.
13. Documents integration friction, with each item classified as a framework defect or an application need.

### ForgeCMS scope

ForgeCMS is the preferred candidate ([RELEASE-1.0 real-world proof](../RELEASE-1.0.md#real-world-proof)). A
sufficient RC0 slice is one authenticated content area: a controller-backed content API with validated writes,
one Server Component that renders stored content server-only, and one island that edits or previews through
that API, deployed and upgraded once.

Everything CMS-specific stays in ForgeCMS: schemas, the editor, roles, storage adapters, media. Strata
gains no dependency on ForgeCMS APIs or schema. This milestone changes no other repository.

### Evidence the adoption must return, in priority order

1. Consumer revision, installed lockfile entries for the three packages (version and integrity) and the
   deployed URL or target.
2. The production build log (Node or Pages) and the browser bundle confidentiality check (no marked module and
   no secret in browser assets or source maps).
3. Authorization evidence: unauthenticated and cross-tenant requests refused before data access.
4. An upgrade and a rollback with build ids, including what a tab open across the deploy saw.
5. Failure behaviour observed in operation: SSR failures with both `/ssr` halves, hydration refusals, error
   rates.
6. Developer feedback and friction, each classified as a **framework defect** (a Strata contract broken, wrong
   documentation, a missing documented capability: fixed in Strata through an `rc.N+1`) or an **application
   need** (a feature request outside the RC contract: recorded, never a GA blocker on its own).

## GA traceability

The 32 criteria of [RELEASE-1.0](../RELEASE-1.0.md), in the order of the [M5 matrix](m5-production-qualification.md#10-exit-criteria-traceability).
RC0 ticks none of them, and no criterion is removed or reworded. App = needs a real application.
Node = needs a persistent Node deployment.

| #   | Criterion (abridged)                                        | Status  | New RC evidence                                   | Remaining                                                                                                   | App | Node |
| --- | ----------------------------------------------------------- | ------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --- | ---- |
| 1   | Stable documented public API                                | PARTIAL | installed inventory of the npm tuple              | stability promise at GA; SemVer policy review                                                               |     |      |
| 2   | Controllers, validation, errors, authorization in real apps | PARTIAL | published-registry consumer of the tuple          | real application                                                                                            | yes |      |
| 3   | Angular/Analog integration dev + prod                       | PARTIAL | packed DI consumer on the versioned tree          | workerd JIT (upstream, `NO-JIT-WORKERD`); shared SSR/controller injector (by design)                        | yes |      |
| 4   | No legacy decorators                                        | PARTIAL | —                                                 | release audit record                                                                                        |     |      |
| 5   | Core independent, owned responsibilities                    | PARTIAL | —                                                 | release audit record                                                                                        |     |      |
| 6   | Native H3 and `serverFn` coexist                            | PARTIAL | —                                                 | `serverFn` on workerd (upstream)                                                                            |     |      |
| 7   | Server/client graph split                                   | PARTIAL | frozen RC tuple                                   | release record                                                                                              |     |      |
| 8   | Server code out of browser chunks and maps                  | PARTIAL | frozen and deployed RC tuple                      | release record                                                                                              |     |      |
| 9   | Server-only dependencies fail closed                        | PARTIAL | —                                                 | unmarked modules (`NO-UNMARKED`, design limit)                                                              |     |      |
| 10  | Interactive descendants hydrate without the server parent   | PARTIAL | deployed RC hydration                             | real application                                                                                            | yes |      |
| 11  | Initial SSR, direct URL, request isolation                  | PARTIAL | deployed tenant isolation of the RC               | production tenant and cache isolation                                                                       | yes |      |
| 12  | One production-safe navigation strategy                     | PARTIAL | —                                                 | production use of document navigation                                                                       | yes |      |
| 13  | Hydration and `@defer` composition                          | PARTIAL | —                                                 | other triggers, nested islands (experimental)                                                               |     |      |
| 14  | Serialization, limits, version skew                         | PARTIAL | deployed 0.x → RC skew                            | protocol stability promise at GA                                                                            |     |      |
| 15  | Failure behaviour safe                                      | PARTIAL | deployed `/ssr` from npm                          | opt-in, not default; no real application                                                                    | yes |      |
| 16  | Authorization, isolation, leak negatives                    | PARTIAL | published security probes of the RC               | production auth, log redaction in a real deployment                                                         | yes |      |
| 17  | Production fixture deployed                                 | PARTIAL | deployed npm RC                                   | a real application deployed                                                                                 | yes |      |
| 18  | Supported Node version and entry                            | PARTIAL | frozen hosted Linux production process            | a persistent Node deployment                                                                                |     | yes  |
| 19  | Cloudflare complete path                                    | PARTIAL | deployed RC                                       | bindings unexercised; JIT NO-GO                                                                             |     |      |
| 20  | Resources, cold start, cancellation                         | PARTIAL | Node RSS rounds, frozen                           | Cloudflare isolate cold start and memory (no reliable platform measurement); cancellation (`NO-DISCONNECT`) |     | yes  |
| 21  | Release and rollback incl. older assets                     | PARTIAL | deployed 0.x → RC upgrade and retained rollback   | real consumer rollback                                                                                      | yes |      |
| 22  | Test suites pass                                            | PARTIAL | hosted CI and Extended on the corrected candidate | release record                                                                                              |     |      |
| 23  | Bundle assertions with positive controls                    | PARTIAL | —                                                 | release record                                                                                              |     |      |
| 24  | Explicit compatibility matrix                               | PARTIAL | RC frozen id and tuple                            | one tuple only                                                                                              |     |      |
| 25  | Published candidate installs cleanly                        | PASS    | npm RC tuple, exact pins, provenance              | —                                                                                                           |     |      |
| 26  | SemVer, prerelease, migration; upgrades exercised           | PARTIAL | first prerelease through the pipeline             | policy review at GA                                                                                         |     |      |
| 27  | Docs, examples, diagnostics                                 | PARTIAL | getting-started journey and troubleshooting       | package README corrections need a release                                                                   |     |      |
| 28  | RISKS dispositions                                          | PARTIAL | —                                                 | R13, R21, cancellation, render-200 default                                                                  |     |      |
| 29  | A real application on the production path                   | NOT RUN | —                                                 | everything                                                                                                  | yes |      |
| 30  | ForgeCMS or an equivalent                                   | NOT RUN | —                                                 | everything                                                                                                  | yes |      |
| 31  | Consumer revision, deployment, observations recorded        | NOT RUN | —                                                 | everything                                                                                                  | yes |      |
| 32  | Consumer migration and rollback                             | NOT RUN | —                                                 | everything                                                                                                  | yes |      |

Totals, unchanged: PASS 1, PARTIAL 27, BLOCKED 0, NOT RUN 4. The "New RC evidence" entries count only once
their rows below pass.

**Explicit limitations, not blockers to fix in Strata.** Workerd cannot run Angular JIT, so Angular DI in
controllers and `serverFn` fail safely there. Controller DI and SSR use separate injectors by design. Streaming SSR
and SPA subtree navigation are out of scope. Cloudflare exposes no reliable isolate cold-start or memory
measurement, and no number is invented for it.

**Finite GA roadmap.**

1. Publish and qualify RC0 (this report).
2. One external adoption against the checklist above; this closes #29 to #32 and supplies the real-application
   evidence for #2, #10–#12, #15–#17 and #21.
3. One persistent Node deployment, ideally behind a real TLS-terminating proxy, for #18 and #20, and for
   `NO-PROXY` if it is to become supported.
4. A maintainer decision on Cloudflare cold start and memory (#20): accept it as unmeasurable, with the
   observed request-level evidence, or name a measurement.
5. Issue #117: observe the cancelled, pending and stale-main Release transitions.
6. The release audit record (#4, #5, #7, #8, #22, #23) and the RISKS disposition review (#28).
7. A maintainer decision on the Angular support range: keep `^22.1.7` declared and 22.2.7 qualified, or narrow
   it in a superseding RC.

Any change to a GA criterion needs a separate, explicit maintainer decision.

## Package READMEs

The READMEs inside the immutable `1.0.0-rc.0` tarballs were audited and need no correction. The
server-components compatibility section already names the RC tuple (Angular 22.2.7, Analog 2.9.7, Nitro
2.13.6, Vite 8.3.8, Wrangler 4.161.0), and the older versions they mention (Angular 22.1.7, Analog 2.7.2) are
explicitly historical lower bounds. They describe the packages, not the release channels, so the RC channel
guidance is in [Getting started](../GETTING-STARTED.md), which the website publishes. Any later README change
ships only with a future authorized release; this milestone changes nothing under `packages/` after
publication.
