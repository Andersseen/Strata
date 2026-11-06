# SPEC-004: First 1.0 release candidate

- Status: **Ready.** The validation tooling is implemented; the release itself needs maintainer
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

## Mandatory checks

Each check must pass on the candidate SHA. `tools/release/rc-evidence.json` records the status, link and
candidate of each; `pnpm release:rc:check` refuses a PASS obtained on another candidate.

| Check                                                      | How                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Aggregate CI `Verify`                                      | `ci.yml`, all jobs, exact SHA                                                |
| Fixed release pipeline observed on a real publish          | one real Release run after the visibility fix, success without manual repair |
| Published baseline: no tag drift, frozen candidate current | `pnpm release:rc:check`                                                      |
| Source-packed candidate, full consumer                     | `pnpm test:full-stack-package-consumer` (mandatory CI)                       |
| Frozen published candidate                                 | Extended `registry-frozen-candidate`                                         |
| Node production process, hosted Linux                      | Extended `node-production`, both candidates                                  |
| SSR integration integrity                                  | Extended `ssr-duplicate-install`                                             |
| Adversarial and multi-isolate security                     | Extended `adversarial`, mandatory `test:full-stack-multi-isolate`            |
| Deployed Cloudflare, candidate on the public endpoint      | `Qualify Full-Stack Strata on Cloudflare`, `source=packed` or `registry`     |
| Deployed upgrade and retained-artifact rollback            | the same workflow, `source=upgrade-rollback`                                 |
| Browser size budgets                                       | Extended `performance`                                                       |
| Prerelease rehearsal                                       | `pnpm release:rc:rehearse` (non-publishing)                                  |

## Risks an RC may accept

Accepted risks are listed in the ledger with `gate: accepted`, printed by the check and repeated in the
RC's release notes. An RC may ship with: no real-application adoption; no persistent Node deployment;
Cloudflare isolate cold start and memory not measurable; hosted #117 pending and stale-main transitions
not yet observed; the documented upstream limitations. None of these may be accepted for GA.

## Failures that prohibit publishing

- Any `gate: blocker` row not PASS on this candidate, or any `pnpm release:rc:check` blocker.
- Any confidentiality, authorization or request-isolation failure, at any evidence level.
- A browser size budget exceeded.
- A candidate that cannot be reproduced with `npm ci`.
- A stable `1.x` version in the release. `classifyRelease` blocks it unless the repository variable
  `STRATA_RELEASE_STABLE_1_0` is `authorized`, which only the GA decision may set.

## Publishing an RC

Maintainer-authorized, through the normal pipeline, from a reviewed PR. Never from a development branch.
The commands were rehearsed by `pnpm release:rc:rehearse`.

```sh
git switch -c release/rc-entry origin/main
# 1. One version line for the RC: in .changeset/config.json set
#    "fixed": [["@strata-sc/core", "@strata-sc/analog", "@strata-sc/server-components"]]
# 2. A major for all three, the only way a 0.x line reaches 1.0.0-rc.0:
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
# 3. Open a PR, merge it after review. CI then Release open "Version Packages";
#    review that it shows 1.0.0-rc.0 for all three, and merge it. Release publishes.
```

Changesets publishes to the `rc` dist-tag, the pre-mode tag. `release:sync-dist-tags` then moves `next`
to the RC, so ADR-005's `@next` holds; `latest` never moves. Afterwards recapture and requalify:

```sh
STRATA_CANDIDATE_CAPTURE="$PWD/tests/full-stack-candidate" pnpm test:full-stack-registry-consumer
pnpm test:full-stack-frozen-candidate
gh workflow run "Qualify Full-Stack Strata on Cloudflare" -f source=registry
```

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
2. A PASS row without a link, or from another candidate, does not count.
3. The rehearsal shows all three at `1.0.0-rc.0`, then `1.0.0-rc.1` after a one-package fix, and a stable
   `1.0.0` refused without authorization, without network writes.

## Required tests

`tools/release/lib/rc-readiness.test.ts`, `tools/release/lib/publication-visibility.test.ts` (stable guard),
and `pnpm release:rc:rehearse`, also run by the Extended `rc0` suite.

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
