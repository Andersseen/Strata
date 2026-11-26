# Pre-RC0 consolidation and contract hardening

Date: 2026-11-24. Branch `stabilize/pre-rc0-consolidation`. Starting `main`:
`1b09a42839ada621e54942233902d44748951dd5` (fast-forwarded from `origin/main`, same SHA).

**Outcome (completed 2026-11-25 by the [RC0 production requalification](rc0-production-requalification.md)).**
Merged as #196 (`43fd963`). Version Packages #188 was regenerated from it on the 0.x line and merged
(`f16fe1e`); #197 (`36dbd4c`) removed the CI job that blocked publication; Release run 45694359277 then
published `@strata-sc/analog` 0.13.0 with S-1 and S-2. The published tuple is core 0.2.2, analog 0.13.0,
server-components 0.17.0. The sections below are the branch-time record; the results after merge are in
[Evidence](#evidence) and [Hosted CI](#hosted-ci).

This work supersedes the RC0 candidate of the [RC0 report](rc0-production-qualification.md). It consolidates
five Dependabot PRs, withdraws the unpublished RC0 entry, resolves `S-1` and `S-2`, repairs the prerelease
rehearsal and requalifies the framework tuple. It publishes nothing and moves no dist-tag.

Evidence levels, never interchangeable: IMPLEMENTED, UNIT QUALIFIED, LOCAL NODE QUALIFIED, LOCAL WORKERD
QUALIFIED, PACKED CONSUMER QUALIFIED, PUBLISHED REGISTRY QUALIFIED, HOSTED CI QUALIFIED, DEPLOYED QUALIFIED,
REAL APPLICATION ADOPTED, GA QUALIFIED.

## Starting state, read directly

| Fact                    | Value on 2026-11-24                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| npm versions            | core 0.2.2, analog 0.12.1, server-components 0.17.0; no `-rc` version of any package                    |
| npm dist-tags           | `latest` and `next` on those versions; no `rc` tag                                                      |
| Changesets              | pre mode (`{"mode":"pre","tag":"rc"}`), `rc-entry.md` (major ×3), `fixed` group of all three (#187)     |
| Version Packages PR     | #188 open, head `801e8e6`, all three `1.0.0-rc.0`, never merged                                         |
| Scheduled Extended      | 42617736998, 43866421681, 45189500731 failed only in the RC readiness job; 12 of 13 jobs passed in each |
| Cause of those failures | `changeset pre enter rc` on a tree already in pre mode ("cannot be run when in pre mode")               |
| Open dependency PRs     | #191 tslib, #192 Analog Content, #193 Tailwind Vite, #194 Angular group, #195 development group         |

No RC was ever published, so the unpublished-entry withdrawal below applies; nothing needed the
published-RC procedure.

## RC0 entry withdrawal

`4e8ff83` (#187) is reverted. That removes `.changeset/pre.json`, the RC-entry Changeset and the `fixed`
group together and returns the repository to independent 0.x lines. `changeset pre exit` was rejected: it
keeps the three pending `major` Changesets and turns them into a stable `1.0.0` proposal on the next
`changeset version`. Nothing had been consumed into `.changeset/pre/`, because #188 was never merged.

After the revert, `pnpm release:state` reports `VERSION_REQUIRED` for the one pending Changeset of this
branch (`@strata-sc/analog` minor). Once this branch is merged, Release opens a `0.x` Version Packages PR
(analog 0.13.0) in place of #188. The procedure is now in
[SPEC-004](../specs/004-first-release-candidate.md#withdrawing-an-unpublished-rc-entry).

## Dependency consolidation

Each Dependabot head was merged into the branch in the suggested order, so its commit stays in history.
`pnpm-lock.yaml` conflicts were never resolved by picking a side: the lockfile was regenerated from the merged
manifests with pnpm 10.30.1. The one manifest conflict (#195 against #194 in the three apps) kept Angular
from #194 and everything else from #195.

| PR   | Head      | Result                                                                                       |
| ---- | --------- | -------------------------------------------------------------------------------------------- |
| #191 | `c54a81a` | integrated unchanged: tslib 2.9.1                                                            |
| #192 | `cce3b72` | integrated; resolved to Analog Content 2.9.7, matching the rest of Analog                    |
| #193 | `e43a0b5` | integrated unchanged: `@tailwindcss/vite` 4.3.4                                              |
| #194 | `70a831a` | integrated; resolved to Angular 22.2.7 for every framework package, see below                |
| #195 | `5e9b1c5` | integrated except `@types/node` 26.6.6, which stays on the Node 22 line (22.20.5), see below |

Adjusted, with reasons:

- **`@types/node` 26 rejected.** `engines` is `>=22.22.3`. Node 26 declarations would typecheck APIs that do not
  exist on the supported runtime. The root keeps 22.20.5, the latest Node 22 types. The three apps and
  `@strata-sc/server-components` now declare it too: they have none, so pnpm resolved Vite's optional
  `@types/node` peer to the newest major for them.
- **Resolution held at the proposed versions.** The merged caret ranges resolve today to Angular 22.3.0,
  nitropack 2.14.0 and Analog 2.9.8, all published after the PRs were opened (nitropack 2.14.0 and Analog
  2.9.8 the day before). The lockfile pins Angular 22.2.7 for every framework package (one patch level,
  matching `@angular/build` and `@angular/cdk` 22.2.7 from #194), Analog 2.9.7 for platform, Angular plugin,
  Nitro plugin and Content, and nitropack 2.13.6. The newer releases arrive as ordinary Dependabot PRs on the
  new baseline. No override, patch or `skipLibCheck` was added.
- **Analog still does not declare `h3`.** `@analogjs/vite-plugin-nitro` 2.9.7 has no `h3` dependency, so the
  existing `packageExtensions` stay.
- **Prettier 3.10.1** reformats three inline Angular templates; the rendered whitespace is unchanged.
- `@agentyx/cli` 0.24.0 (only the session hook uses it): `agentyx doctor --hook` exits 0.
- `@angular/build` 22.2.7 pins its own Vite 8.3.5 next to the workspace's 8.3.8, as 22.1.8 did with 8.1.5.

## Framework tuple

| Package                       | Previous candidate      | Proposed                | Where                             |
| ----------------------------- | ----------------------- | ----------------------- | --------------------------------- |
| Angular framework             | 22.2.3                  | 22.2.7                  | workspace, every external fixture |
| `@angular/build`              | 22.1.8                  | 22.2.7                  | workspace, fixtures               |
| Analog platform, Vite plugin  | 2.7.2                   | 2.9.7                   | workspace, fixtures               |
| `@analogjs/vite-plugin-nitro` | 2.9.6 (floating)        | 2.9.7                   | pinned in fixtures                |
| `@analogjs/router`            | 2.7.2 / 2.8.1           | 2.8.1                   | workspace, fixtures               |
| nitropack / h3                | 2.13.4 / 1.15.11        | 2.13.6 / 1.15.11        | workspace, fixtures               |
| Vite                          | 8.3.0                   | 8.3.8                   | workspace, fixtures               |
| Wrangler / workerd            | 4.135.0 / 1.20260918.1  | 4.161.0 / 1.20261110.1  | workspace, fixtures               |
| TypeScript                    | 6.0.3, 5.9.2            | unchanged               | declarations                      |
| Playwright                    | 1.62.1                  | 1.65.0                  | runner                            |
| tslib / zod / `@types/node`   | 2.8.1 / 4.6.5 / 22.20.3 | 2.9.1 / 4.6.7 / 22.20.5 | fixtures                          |

The external consumers install outside the workspace lockfile, so their manifests had kept the previous tuple
(the performance fixture even Angular 22.1.7). Without moving them, the packed, registry and performance
suites would have qualified the old tuple while the workspace claimed the new one. All five fixture manifests
now pin the proposed tuple. Two version sets were deliberately not moved: the SPEC-002 H3 v2 experiment's
mandated pins (private `@strata-sc/h3`, out of scope), and the frozen candidate, which is historical and was
recaptured instead (see [Evidence](#evidence)).

The Angular peer range `^22.1.7` of server-components is neither widened nor narrowed. Its lower bound is no
longer exercised anywhere; only 22.2.7 is qualified.

## S-1: request URL integrity

**Finding.** On Nitro `node-server`, `request.url` was the path resolved against `http://localhost`. An
origin check against it refused legitimate requests and would accept `Origin: http://localhost`.

**Adapters, read in the resolved tuple.**

| Source                           | What it does                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H3 1.15.11 `getRequestURL`       | trusts `X-Forwarded-Proto: https` unless told otherwise, takes `Host` unchecked, falls back to `localhost`                                                   |
| Nitro 2.13.6 Cloudflare entries  | call H3 through a mock Node request built with `protocol: url.protocol` (`"https:"`), which the mock compares with `"https"`: the socket reads as plain HTTP |
| Nitro 2.13.6 `onRequest`         | puts the Worker's own `Request` in `event.context.cloudflare.request` (documented)                                                                           |
| Vite 8.3.8 dev server            | answers `403 Blocked request` for a `Host` outside `server.allowedHosts`, before Nitro runs                                                                  |
| local workerd (Wrangler 4.161.0) | builds the Worker's request URL from the client's `Host`; `Host: evil.test/admin` moves the path to `/admin/...`                                             |

H3's helper is therefore not used: its defaults trust a forwarded header and invent `localhost`, and on Pages
it reports `http`.

**Contract** (`packages/analog/src/request-url.ts`):

- Path and query are the routed target. An absolute-form or scheme-relative target contributes its path only.
- The origin is, in order: the consumer's `publicOrigin` option; the URL the runtime received (H3's web
  adapter, `event.context.cloudflare.request`); on Node the syntax-checked `Host` with the socket's own TLS
  state; otherwise `http://strata.invalid`. `.invalid` is reserved (RFC 6761), so no browser origin can match
  it. `X-Forwarded-*` and `Forwarded` are never read.
- Only `publicOrigin` is deployment identity. Every other origin is transport information that the client or
  an intermediary chose. Behind a TLS-terminating proxy the transport origin is `http://…`, which fails an
  origin check closed.
- `publicOrigin` is validated at registration (absolute `http(s)` origin, nothing else) and throws
  `StrataAnalogConfigurationError` otherwise. It is one option, not a proxy-trust or CSRF framework.

What consumers may trust: `request.path`, `request.url.pathname`, `request.url.search` and `request.query`
as the request target; `request.url.origin` only when they set `publicOrigin`.

**Tests.** `packages/analog/src/request-url.test.ts` (33 tests): real `node:http` and `node:https` servers
behind H3's `toNodeListener`, raw sockets for what no client would send. Direct requests, custom host and
port, IPv6, TLS from the socket, a forwarded downgrade and upgrade, ten malformed `Host` forms, a missing
`Host`, absolute-form and `//` targets, exact query strings, 48 concurrent requests with distinct hosts, the
web adapter, the Cloudflare context, `publicOrigin` validation before the router is touched, and a consumer
origin guard. The Analog fixture repeats the runtime-facing checks on the Nitro `node-server` build, the Vite
dev server and local workerd (`pnpm test:analog-headers`). Deployed Cloudflare and a real reverse proxy are
not covered.

## S-2: controller constructor typing

**Finding.** `ControllerClass = new () => object` rejected a controller with constructor parameters even
with a `controllerFactory` that builds it; the README's streaming example did not typecheck.

**Change.** `ControllerClass` is unchanged and stays the requirement without a factory, so the default
`new Controller()` stays type-safe. New `ControllerConstructor = new (...args: never) => object` admits any
constructor and cannot be called with `new` and no arguments. A second `registerControllers()` overload
accepts it only with a `controllerFactory` typed for those classes.
`StrataAnalogControllerFactory<Controller>` and `RegisterControllersOptions<Controller>` gain a type parameter
that defaults to `ControllerClass`. Runtime validation of the factory result, request-scoped cleanup,
guards, interceptors and inheritance are unchanged. Arity is not checked at runtime: `Function.length`
counts optional TypeScript parameters, so the earliest reliable boundary is the compiler.

**API impact.** Additive: one new exported type (inventory updated), one overload, two defaulted type
parameters. Existing calls compile unchanged.

**Tests.** `packages/analog/src/controller-constructor.test.ts`: zero-argument, optional-parameter and
required-parameter controllers, a typed and a registry-style factory, inheritance, an invalid factory result
and a rejecting factory (cleanups run), guards before and interceptors around construction, and compile-time
assertions enforced by `pnpm typecheck`. From the installed tarballs under TypeScript 6.0.3 and 5.9.2 with
`skipLibCheck: false`: `tests/full-stack-package-consumer/fixture/src/check/analog-contract-example.ts`,
compiled when the installed analog is 0.13.0 or later. The README's streaming example now registers its
controller without a cast.

## Prerelease rehearsal

**Root cause.** `rehearsePrerelease` always performed the RC entry and ran `changeset pre enter rc`. With
the entry on `main`, the scheduled Extended `rc0` job failed every week, and a superseding `rc.N+1` could
never be rehearsed.

**Fix.** `tools/release/lib/rc-rehearsal.ts` classifies the throwaway clone and performs only the steps it
still needs:

| Tree                                                                      | Steps                                    | Versions rehearsed      |
| ------------------------------------------------------------------------- | ---------------------------------------- | ----------------------- |
| 0.x, not in pre mode                                                      | fixed group, major ×3, `pre enter rc`    | `rc.0`, then `rc.1`     |
| 0.x, `rc` pre mode (entry merged)                                         | none: the merged entry is what is tested | `rc.0`, then `rc.1`     |
| `1.0.0-rc.N`, `rc` pre mode                                               | a one-package patch                      | `rc.N+1`, then `rc.N+2` |
| pending `pre exit`, other tag, split tuple, entry without the fixed group | refused                                  | none                    |

Every other check keeps its strength and now uses the planned versions: installed tarballs, exact internal
pins, one copy of each package, export targets, versioning-only diff, consumed Changesets, the Release
classifier, dist-tag plans, and the stable `1.0.0` refusal without `STRATA_RELEASE_STABLE_1_0`. The clone
still has no remote and no npm or GitHub credentials, and `changeset publish` is never invoked.

**Evidence.** UNIT: `tools/release/lib/rc-rehearsal.test.ts` (15 tests) drives the real Changesets 3.0.3
CLI on a synthetic workspace from each state and reproduces the original refusal. Full rehearsal, locally,
from three real trees: this branch (0.x, 15 of 15 checks), `main` at `1b09a42` with only the new tooling
applied (the entered tree that failed on schedule, 15 of 15, no `pre enter`), and that tree versioned to
`rc.0` (15 of 15, `rc.1` then `rc.2`).

**Consequence.** `tools/release/` changed, so `release-pipeline-observed` is invalid. The next real publish
through Release must be observed again. It does not need an artificial bump: merging this branch leaves one
legitimate pending release (analog 0.13.0 for S-1 and S-2).

## Upstream findings

- nitropack 2.13.6 reports itself as 2.13.5 in `nitropack/meta`, and therefore in `nitro.json`. `pnpm
test:analog` now ties the build to the resolved package through that package's own constant and names
  this mislabel, instead of comparing with `package.json`.
- Nitro's Cloudflare entries mark the mock socket unencrypted for HTTPS (above). Strata no longer depends on
  it.
- Local workerd folds the `Host` header into the Worker's URL. A malformed `Host` changes the path the Worker
  routes on; no Strata route received such a request in the fixture.

## Evidence

Two kinds of evidence, kept apart. **Historical**: what #196 and #197 recorded, reconstructed from their
commits, PR descriptions and hosted runs. **This development**: results obtained on 2026-11-25 in the
[RC0 production requalification](rc0-production-requalification.md); they are not repeated here.

**Historical, from #196 (`6a19b3a`, merged `43fd963`).** The PR description was never completed (it still
reads "Description in progress"), so no local matrix of that branch can be established beyond what this
report and the commits record:

| Claim                                                       | Source                                                     | Level     |
| ----------------------------------------------------------- | ---------------------------------------------------------- | --------- |
| `request-url.test.ts`, 33 tests (S-1)                       | the test file at `ac3021b`, re-run by every `pnpm test`    | UNIT      |
| `controller-constructor.test.ts` and compile assertions     | the test file at `ac3021b`, `pnpm typecheck`               | UNIT      |
| S-1 on Nitro `node-server`, Vite dev and local workerd      | `pnpm test:analog-headers`, adapted in `677de2a`           | LOCAL     |
| Rehearsal 15 of 15 from three real trees                    | [Prerelease rehearsal](#prerelease-rehearsal), this report | LOCAL     |
| `rc-rehearsal.test.ts`, 15 tests on the real Changesets CLI | the test file at `ec3da08`                                 | UNIT      |
| S-2 example from installed declarations, TS 6.0.3 and 5.9.2 | packed consumer in hosted CI 45633829823                   | HOSTED CI |

Three hosted CI failures of the consolidated tuple were fixed on the branch rather than accepted
(`5d5c551`, `f8ff9f2`, `6a19b3a`): the S-1/S-2 declaration gate read the manifest version instead of the
installed declarations; Wrangler 4.161.0's dev proxy replays a failed streaming GET; and Chromium aborts a
lazy chunk of a document being replaced. Each fix keeps the original claim and is described in its commit.

**Not done by #196, contrary to the earlier text of [COMPATIBILITY](../COMPATIBILITY.md).** The frozen
candidate was not recaptured on the consolidated tuple: `tests/full-stack-candidate/candidate.json` stayed
`983f7131e39574e0` (analog 0.12.1, Angular 22.2.3, captured 2026-11-07 at `3b497d9`). #197 deferred the
capture on purpose, because analog 0.12.1 was about to be superseded. The capture on the published 0.13.0
tuple is in the [requalification](rc0-production-requalification.md#frozen-baseline).

**Historical, from #197 (`467d948`, merged `36dbd4c`).** Its description records, on macOS arm64 with Node
22.23.1: `pnpm format:check`, `pnpm lint`, actionlint 1.7.12, `pnpm test`,
`pnpm test:full-stack-registry-upgrade-rollback` (the 0.16.0 → 0.17.0 pair on analog 0.12.1),
`pnpm test:full-stack-adversarial-security` (smoke and full), the one- and three-island performance profiles
with the comparison, and the controller-scaling profile, all passing. These are maintainer-reported local
results; no artifact of them is retained. The suite fixes were: performance arms installed with their peers
(Analog router 2.8.1 needs `@analogjs/content` in the Cloudflare server bundle) and, in the skew scenarios,
acceptance of exactly the files the stale deployment answers with 404, never a broader console filter.

**Consolidated dependency versions, as merged.** The table in [Framework tuple](#framework-tuple) is what
`main` resolves at `36dbd4c` and what the 2026-11-25 capture recorded from a fresh registry install; the
capture is the authority for transitive versions. Deviations from the Dependabot proposals stay as decided
above: `@types/node` held at 22.20.5 (Node 22 line, matching `engines` `>=22.22.3`, so declarations never
admit APIs the supported runtime lacks), resolution held at Angular 22.2.7, Analog 2.9.7 and nitropack 2.13.6
rather than the newer releases a fresh resolution would pick, and the `h3` `packageExtensions` kept.

## Hosted CI

Every run below was read from the GitHub API on 2026-11-25. Runs on a pull-request head are branch
evidence; only runs on a `main` push or dispatched on the candidate count for the RC gate.

| Run         | Workflow (event)         | Commit                      | Result                                                                                     |
| ----------- | ------------------------ | --------------------------- | ------------------------------------------------------------------------------------------ |
| 45406810583 | CI (pull_request)        | #196 head, first push       | failure, fixed by `5d5c551`                                                                |
| 45411437742 | CI (pull_request)        | #196 head                   | failure, fixed by `f8ff9f2` and `6a19b3a`                                                  |
| 45633829823 | CI (pull_request)        | `6a19b3a` (#196 final head) | success: 11 jobs and `Verify`; deploy and redirect skipped (main only)                     |
| 45633829670 | Verify published SC (PR) | `6a19b3a`                   | success                                                                                    |
| 45635597736 | CI (push)                | `43fd963` (#196 merge)      | success                                                                                    |
| 45637428004 | Release (workflow_run)   | `43fd963`                   | success; opened Version Packages #188 on the 0.x line (publish steps skipped)              |
| 45638575614 | CI (push)                | `f16fe1e` (#188 merge)      | **failure**: only "Redirect GitHub Pages to the official documentation" (`deploy-pages`)   |
| 45641324276 | Release (workflow_run)   | `f16fe1e`                   | failure at "Verify exact main CI result": the main CI run was not green; nothing published |
| 45646864876 | Release (workflow_run)   | `f16fe1e`                   | same refusal after a CI re-run                                                             |
| 45647626060 | Release (workflow_run)   | `f16fe1e`                   | same refusal after a CI re-run                                                             |
| 45681199882 | CI (pull_request)        | `467d948` (#197 head)       | success: 11 jobs and `Verify`                                                              |
| 45692799424 | CI (push)                | `36dbd4c` (#197 merge)      | success                                                                                    |
| 45694359277 | Release (workflow_run)   | `36dbd4c`                   | **success: published analog 0.13.0**, see below                                            |
| 45694359275 | GitHub Pages redirect    | `36dbd4c`                   | success (the job #197 moved out of CI)                                                     |

Release 45694359277, step by step: "Verify exact main CI result" success; "Classify release state"
`PUBLISH_REQUIRED` ("1 unpublished version(s) (partial release; 2 already published)"); "Authorize
release candidate" skipped (no `-rc.` version); "Repair dist-tags of already published versions"
skipped; "Version PR or publish to npm" ran `changeset publish` (Changesets 3.0.3, `NPM_CONFIG_PROVENANCE`
true) and printed "Successfully published: @strata-sc/analog@0.13.0"; "Align npm dist-tags" moved analog
`next` 0.12.1 → 0.13.0 and found core and server-components compliant; "Verify npm registry, tags and
GitHub Releases" printed `Registry verification: PASS`. The two registry-consumer steps were skipped:
they run only when server-components is published. No manual publish and no manual dist-tag change took
place. This run is the `release-pipeline-observed` candidate proof: neither `tools/release/**` nor
`release.yml` has changed since.

Not run since #196 on any ref: Extended (the last, scheduled 45189500731 on 2026-11-23, predates the
consolidation) and Qualify Full-Stack Strata on Cloudflare (the last, 42374571852, on 2026-11-07).

## Remaining RC0 blockers

Superseded by the [RC0 production requalification](rc0-production-requalification.md#remaining-rc-blockers),
which carries the current list. In short, after this consolidation and the 0.13.0 publication:

- **Done**: dependency consolidation, S-1, S-2, rehearsal repair, RC0 withdrawal, the real publish through
  the corrected pipeline (`release-pipeline-observed` can cite Release 45694359277).
- **Pending the next main merge**: the candidate commit itself, and every row bound to it (`ci-verify`,
  Extended `suite=all`, the three Cloudflare dispatches).
- **Pending maintainer authorization**: `support-contract-review` for the revised contract, then the ledger
  PR and the RC entry.
- **Accepted, not closable by tooling**: real-application adoption, persistent Node, Cloudflare cold start
  and memory, issue #117 transitions.
