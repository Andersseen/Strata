# SPEC-004: First 1.0 release candidate

- Status: **Ready.** The gate and its rehearsal are implemented; the release itself needs maintainer
  authorization and is not started by this spec. The current verdict is in the
  [RC0 report](../research/rc0-production-qualification.md).
- Baseline: `ff3f1a4` (`main`, after PR #175)
- Milestone: M5
- Owner: maintainer (Andersseen) decides; release engineering prepares
- Depends on: [ADR-005](../adr/005-npm-dist-tag-channels.md), [RELEASE-1.0](../RELEASE-1.0.md),
  [COMPATIBILITY](../COMPATIBILITY.md)
- Risks: R05, R21, and the release items in [RISKS](../RISKS.md)

## Context

Strata ships three public packages on independent `0.x` lines. Every API is experimental and nothing
says which package versions belong together. Many qualifications passed, each against a different
tuple. [RELEASE-1.0](../RELEASE-1.0.md) stays the authority for General Availability (GA); it has no
step between "experimental 0.x" and "certified 1.0".

## Problem

There is no defined way to ask real users to evaluate one identified Strata release: no tuple, no
support statement, no publishing rule, no rollback and no way to replace a bad candidate.

## Goals

An RC is one tuple, with a stated support matrix, published only if a fixed list of checks passed on
that exact candidate, and replaceable by the next RC. `pnpm release:rc:check` answers "can we propose
it now" from evidence.

## Non-goals

An RC is not GA and does not tick items in [RELEASE-1.0](../RELEASE-1.0.md). It does not promise API
stability between RCs. The four real-application requirements stay open and stay separate.

## Public API impact

None. This spec fixes process; the API included in an RC is the machine-checked inventory
`tools/package-consumer/public-api.json` at the candidate SHA.

## The RC tuple

All three public packages, one version, moved together:

```text
@strata-sc/core                1.0.0-rc.N
@strata-sc/analog              1.0.0-rc.N
@strata-sc/server-components   1.0.0-rc.N
```

`@strata-sc/h3` is private and not part of it. A fix to one package produces a new RC of all three, so
"rc.N" alone identifies a tuple. That needs a Changesets `fixed` group, added by the RC-entry commit and
removed at GA or if RCs stop: on the `0.x` line it would wrongly lock three independent versions.

The rest of the tuple is the frozen candidate: `tests/full-stack-candidate` records the exact Angular,
Analog, Vite, Nitro and Wrangler versions, the full dependency tree and the Node and compatibility-date
toolchain. The supported runtime combinations are the "Supported for RC evaluation" rows of the
[COMPATIBILITY](../COMPATIBILITY.md#rc0-support-contract) contract, and nothing else.

## Requirements

The catalog in `tools/release/lib/rc-catalog.ts` lists every requirement, with a stable id, its class
(`blocker` or `accepted`), its phase and the exact workflow, jobs and steps that prove it. Reports and
reviews cite these ids; positional numbers are not stable references. `tools/release/rc-evidence.json`
records results against the catalog and can neither omit a requirement nor reclassify one.

**Phase `pre` authorizes publication.** It asks only for what can exist before the RC does:

| Id                          | Proves                                                      | Artifact          |
| --------------------------- | ----------------------------------------------------------- | ----------------- |
| `ci-verify`                 | aggregate CI `Verify` on the candidate's main push          | source-packed     |
| `release-pipeline-observed` | a real publish through the current pipeline, no repair      | none              |
| `baseline-frozen`           | `npm ci` of the frozen published 0.x tuple                  | baseline registry |
| `baseline-deployed`         | that tuple on Cloudflare Pages                              | baseline registry |
| `baseline-upgrade-rollback` | deployed upgrade and retained-artifact rollback onto it     | baseline registry |
| `island-interaction`        | one and three islands, hydrated and replayed, all four arms | source-packed     |
| `performance-scaling`       | controller scaling and browser size budgets                 | source-packed     |
| `ssr-duplicate-install`     | `/ssr` with duplicated installations                        | source-packed     |
| `node-production-source`    | Node production process on hosted Linux                     | source-packed     |
| `adversarial-security`      | source-mutated security qualification                       | source-packed     |
| `deployed-source-packed`    | the candidate on Cloudflare Pages                           | source-packed     |
| `prerelease-rehearsal`      | `pnpm release:rc:rehearse`                                  | none              |
| `support-contract-review`   | the maintainer's merged review                              | none              |

**Phase `post` qualifies the exact artifacts on npm**: `rc-publication`, `rc-frozen`, `rc-node-production`,
`rc-deployed` and `rc-upgrade-rollback`. It also reads npm: every version at the target, with the recorded
integrity and a provenance attestation, `next` on the RC and `latest` not on it.

A row is bound to one tuple, so 0.x baseline evidence cannot pass as the RC, and the first RC is not
needed to authorize itself.

## How a verdict is computed

The ledger says where to look; it is not believed. A row that cannot be checked is a blocker.

- **PASS needs proof.** A hosted row names a run id. The gate reads the run from the GitHub API and
  requires the catalog's workflow, event, repository, exact jobs and steps, each concluded `success`. A
  failed, cancelled, skipped or pending job, or a step skipped because the run only opened a Version PR,
  does not count. A manually written URL is not accepted as proof.
- **Candidate identity.** `candidate` records the commit and, recomputed from it, the `packages/` tree
  hash, the `pnpm-lock.yaml` digest, the configuration digest and the package versions.
- **Tuple identity.** `baseline` and `published` record each artifact's version and sha512 integrity, the
  frozen candidate id and the harness commit. The frozen candidate committed at that commit must be
  exactly this tuple, and npm must serve that integrity.
- **Harness.** Hosted runs check out one commit, so a run's harness is its own head SHA. Source-packed
  rows tie it to the candidate, registry rows to the tuple's harness commit.

Evidence is reused across commits only when the diff is computed to allow it:

| Between                                             | Allowed diff                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A run and its anchor; the candidate and `HEAD`      | documentation: `docs/**`, root `*.md`, the ledger. `packages/**` READMEs are excluded, because they ship in tarballs             |
| The candidate and the publishing commit             | also versioning: `.changeset/**`, changelogs, and manifests that are identical once versions and `@strata-sc/*` pins are removed |
| A `release-pipeline-observed` run and the candidate | anything except `tools/release/**` (the ledger aside) and `release.yml`                                                          |

`pnpm release:rc:check` exits 1 on NO-GO. `--report` prints the verdict and exits 0: that run, and the
Extended job built on it, prove the rehearsal only and never authorize a release. Release itself runs
`--phase=pre --publishing` before it publishes any `-rc.` version.

## Risks an RC may accept

Accepted risks are the catalog's `accepted` rows, printed by the check and repeated in the RC's release
notes. They have no proof kind, so the ledger cannot mark them PASS: real-application adoption stays
outside this tooling. An RC may ship with: no real-application adoption; no persistent Node deployment;
Cloudflare isolate cold start and memory not measurable; hosted #117 pending and stale-main transitions
not yet observed; the documented upstream limitations. None of these may be accepted for GA.

## Failures that prohibit publishing

- Any `pnpm release:rc:check` blocker. Release enforces this for every `-rc.` version.
- Any confidentiality, authorization or request-isolation failure, at any evidence level.
- A browser size budget exceeded.
- A candidate that cannot be reproduced with `npm ci`.
- A stable `1.x` version in the release. `classifyRelease` blocks it unless the repository variable
  `STRATA_RELEASE_STABLE_1_0` is `authorized`, which only the GA decision may set.

## Publishing an RC

Maintainer-authorized, through the normal pipeline, from reviewed PRs. Never from a development branch. Each
step's result decides the next; a failure stops the sequence. The commands were rehearsed by
`pnpm release:rc:rehearse`.

**1. Baseline.** Merging to `main` with a pending version publishes it: the merge's CI, then Release. Confirm
the Release run published, with `Align npm dist-tags` and `Verify npm registry, tags and GitHub Releases`
green. That run is `release-pipeline-observed`.

**2. Recapture the baseline.** In a PR, move `DEFAULT_PAIR` in `tools/server-components/lib/upgrade-rollback.ts`
to the two latest minors and capture:

```sh
STRATA_CANDIDATE_CAPTURE="$PWD/tests/full-stack-candidate" pnpm test:full-stack-registry-consumer
pnpm test:full-stack-frozen-candidate
```

Its merge commit is the baseline's `harnessSha`. On that commit run Extended (`suite=registry`) and
`Qualify Full-Stack Strata on Cloudflare` with `source=registry` and `source=upgrade-rollback`.

**3. Enter the RC line.** The merge of this PR is the candidate.

```sh
git switch -c release/rc-entry origin/main
# One version line for the RC: in .changeset/config.json set
#    "fixed": [["@strata-sc/core", "@strata-sc/analog", "@strata-sc/server-components"]]
# A major for all three, the only way a 0.x line reaches 1.0.0-rc.0:
cat > .changeset/rc-entry.md <<'NOTES'
---
"@strata-sc/core": major
"@strata-sc/analog": major
"@strata-sc/server-components": major
---

First 1.0 release candidate. See docs/COMPATIBILITY.md for the supported combinations.
NOTES
pnpm changeset pre enter rc
git add .changeset && git commit -m "chore(release): enter the 1.0 release candidate line"
```

Release then opens "Version Packages". **Do not merge it yet.**

**4. Qualify the candidate.** On the candidate commit run Extended with `suite=all`, `islands=both`, and
`Qualify Full-Stack Strata on Cloudflare` with `source=packed`.

**5. Record and review.** In a PR that changes only the ledger and documentation, set `candidate` from
`pnpm release:rc:check --print-candidate=<sha>`, set `baseline`, and fill each row with its run id. The
maintainer's merge of this PR is `support-contract-review`: its number goes in that row in a further
ledger-only PR, or the row names an earlier review PR. `pnpm release:rc:check` must print GO.

**6. Publish.** Check that "Version Packages" shows `1.0.0-rc.0` for all three and merge it. CI runs, and Release
re-runs the gate with `--publishing` before publishing. Changesets publishes to the `rc` dist-tag, the
pre-mode tag. `release:sync-dist-tags` then moves `next` to the RC, so ADR-005's `@next` holds; `latest`
never moves.

**7. Qualify the artifacts.** Repeat step 2's capture and runs for the RC, add Extended `suite=rc0` for
`rc-node-production`, fill `published` and the `rc-*` rows, and run `pnpm release:rc:check --phase=post`. RC0
is finished only when that prints GO.

## Superseding an RC

A later RC replaces the previous one for evaluation; nothing is unpublished. Add Changesets for the fix and
merge the Version Packages PR: the `fixed` group moves all three to `1.0.0-rc.N+1`, and that tuple needs its
own evidence rows. The previous RC stays installable by exact version.

## Rolling back a bad RC

npm versions are immutable; rollback moves consumers, not packages. Never unpublish, and never republish a
version.

1. Stop: no new RC until the cause is known. Record the failure in the report.
2. `npm deprecate "@strata-sc/<pkg>@1.0.0-rc.N" "<reason>; use <replacement>"` for all three.
3. Publish `rc.N+1` if the fix is ready. `next` then moves forward by policy.
4. If it is not ready, tell evaluators the last good tuple. Moving `next` backwards contradicts ADR-005 and
   the release tooling refuses it, so it needs a recorded maintainer decision and a manual
   `npm dist-tag add`, outside the pipeline.
5. An application rolls back by redeploying its retained previous build: the deployed rollback evidence
   covers retained artifacts, including assets of the older deployment.

## Reaching GA

`changeset pre exit`, then the GA-only authorization and every item of [RELEASE-1.0](../RELEASE-1.0.md).
Remaining evidence is listed per criterion in the [RC0 report](../research/rc0-production-qualification.md).

## Acceptance criteria

1. `pnpm release:rc:check` prints a verdict with ranked blockers and exits 1 on NO-GO.
2. A ledger that omits, adds or reclassifies a requirement, or claims a PASS without proof, is NO-GO.
3. A PASS counts only if its run reads back as successful on an allowed commit for the right artifact.
4. A release candidate cannot publish through Release without a GO for its own code.
5. The rehearsal shows all three at `1.0.0-rc.0` with installed exports and exact dependencies, then
   `1.0.0-rc.1` after a one-package fix, `latest` unmoved, and a stable `1.0.0` refused without
   authorization, without network writes.

## Required tests

`tools/release/lib/rc-readiness.test.ts` (adversarial ledgers, hosted results, identities and tuples),
`tools/release/lib/publication-visibility.test.ts` (stable guard), and `pnpm release:rc:rehearse`, also run
by the Extended `rc0` suite.

## Compatibility concerns

Exact tuple: [COMPATIBILITY](../COMPATIBILITY.md). The rehearsal covers Changesets 3.0.3; its pre-mode layout
(`.changeset/pre/`, `pre.json` holding only `mode` and `tag`) differs from Changesets 2, so a CLI upgrade must
rerun it.

## Risks

An RC widens exposure of experimental behavior. The support contract, and the honest limits it lists, are the
mitigation. A real publish through pre mode has never run: `changesets/action` is not exercised by the
rehearsal, which is why the first RC must be watched and the recapture above is mandatory.

## Definition of Done

Tooling merged, the ledger current, and the maintainer holding either an exact release proposal or a short
ranked blocker list.

## Explicitly out of scope

Publishing, tagging, or changing dist-tags; real-application adoption; new features; the `fixed` group on the
`0.x` line.
