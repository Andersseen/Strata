# RC0 production requalification of the published baseline

Date: 2026-11-25. Branch `stabilize/rc0-production-requalification`, PR #198. Starting `main`:
`36dbd4c0d4370b20a5923651e50e0081bfc9c9b5` (local `main` fast-forwarded to `origin/main`, same SHA). Follows the
[pre-RC0 consolidation](pre-rc0-consolidation.md) and performs [SPEC-004](../specs/004-first-release-candidate.md)
steps 1 and 2. Publishes nothing, moves no dist-tag, does not enter pre mode, records no ledger row.

**Merge state.** The maintainer merged #198 on 2026-11-25 at 21:18 UTC with head `ddbe4f4` (the S-1 fixture and
A/B pair, then the frozen baseline). Its merge commit **`4888fe6cfa6ece91901f80b243f66fcbd3358b22`** has the same
tree as `ddbe4f4` and is the candidate and the baseline harness commit. This report and the other documentation
followed in a documentation-only PR, so the diff between the candidate and `main` stays inside what the gate
allows (`docs/**`). The published "RC0 support contract" section of COMPATIBILITY was deliberately left unchanged:
editing it also changes the website's synced copy under `apps/www`, which the gate counts as code.

Evidence levels as in the consolidation report. A **branch** result (local, or hosted on the PR head) is never the
main-bound evidence the RC gate requires; those runs are listed under [Next steps](#next-steps).

## Verdict

- The Release pipeline published `@strata-sc/analog` 0.13.0 for real (run 45694359277). npm serves the expected
  tuple with provenance and no RC artifact.
- The published tuple is frozen as **`e04b7bb1180795f3`** and reproduces with `npm ci`.
- The upgrade/rollback pair now runs on analog 0.13.0; Analog's own 0.12.1 → 0.13.0 transition was run as a
  separate scenario.
- S-1 is exercised from the installed packages on Node, Node production, local workerd and **deployed Cloudflare
  Pages**, closing the deployed gap the consolidation left. S-2 compiles from the installed declarations under
  TypeScript 6.0.3 and 5.9.2.
- Every hosted qualification on this branch passed: CI, Extended `suite=all islands=both` (13 of 13 jobs) and the
  three Cloudflare qualifications, all on the tree of the candidate `4888fe6`. No runtime defect was found and no
  package source changed.
- RC0 stays **NO-GO** until the main-bound runs, the ledger PR and the maintainer's review exist. That is the
  expected state, not a failure.

## Published registry state

Read from `registry.npmjs.org` on 2026-11-25.

| Package                        | Version | `latest` | `next` | sha512 integrity                                                                                  |
| ------------------------------ | ------- | -------- | ------ | ------------------------------------------------------------------------------------------------- |
| `@strata-sc/core`              | 0.2.2   | 0.2.2    | 0.2.2  | `sha512-Xr6bMt7funa/RtMhr/BTLX548alI8w5/tq/4QIgvk4INEc4nED5CweQUeEujPU6o9/NcJ1XFtqcXPNGjohkHFA==` |
| `@strata-sc/analog`            | 0.13.0  | 0.13.0   | 0.13.0 | `sha512-AI3RioayTDdWT+Y0VA3FslbVzNTMtWGump6N1XEWtGk2qqSIb4pWR58QPGnMucCKLN6NVzSXCly9dSeA66OipA==` |
| `@strata-sc/server-components` | 0.17.0  | 0.17.0   | 0.17.0 | `sha512-SOrJTSac6qRhpI8cn3QL4Cr4jslHN0gwTHA9H9iSCepOHhVenzK/tpo0y0GbGh6JqoLd1/qBBx1QUj4uwMr/Og==` |

Tarballs are `https://registry.npmjs.org/@strata-sc/<name>/-/<name>-<version>.tgz`. Each version carries an SLSA
provenance attestation (`https://slsa.dev/provenance/v1`). No package has a `-rc.` version or an `rc` dist-tag.
`@strata-sc/h3` is not on npm (private, 0.1.0). GitHub Release `@strata-sc/analog@0.13.0` exists (2026-11-25
20:24 UTC, marked latest).

Changesets: no `.changeset/pre.json`, no RC-entry Changeset, `fixed` and `linked` empty, no pending `major`. The
only Changeset is #198's empty one. `pnpm release:state` reports `ALREADY_PUBLISHED` (the settled state;
there is no separate "synchronized" state) and `pnpm release:verify` reports `Registry verification: PASS`.

## Release workflow observation

Release 45694359277 (`workflow_run` from CI 45692799424 on `36dbd4c`), every step read from the API:

| Step                                               | Result                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| Verify exact main CI result                        | success                                                                    |
| Classify release state                             | `PUBLISH_REQUIRED`: one unpublished version, two already published         |
| Authorize release candidate                        | skipped: no `-rc.` version                                                 |
| Recheck exact main CI result before release action | success                                                                    |
| Repair dist-tags of already published versions     | skipped: nothing to repair                                                 |
| Version PR or publish to npm                       | `changeset publish`, provenance on: "Successfully published" analog 0.13.0 |
| Align npm dist-tags                                | analog `next` 0.12.1 → 0.13.0; core and server-components already comply   |
| Verify npm registry, tags and GitHub Releases      | `Registry verification: PASS`                                              |
| Registry-consumer steps for server-components      | skipped: they run only when server-components publishes                    |

It satisfies the catalog proof of `release-pipeline-observed` (the three steps above, each `success`). Its binding
allows any diff to the candidate except `tools/release/**` (the ledger aside) and `release.yml`; #198 changed
neither, so the run stays usable for the candidate `4888fe6`. The three earlier refusals
(45641324276, 45646864876, 45647626060) were the pipeline correctly refusing a red main CI run; see the
[consolidation report](pre-rc0-consolidation.md#hosted-ci).

## Frozen baseline

Captured by the repository mechanism at `cf137c5` (the S-1 fixture commit below):

```sh
STRATA_CANDIDATE_CAPTURE="$PWD/tests/full-stack-candidate" pnpm test:full-stack-registry-consumer   # PASS, 240 s
pnpm test:full-stack-frozen-candidate                                                               # PASS, 397 s
```

| Field               | `e04b7bb1180795f3` (new)                                             | `983f7131e39574e0` (historical)         |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| Strata              | core 0.2.2, analog **0.13.0**, SC 0.17.0                             | core 0.2.2, analog 0.12.1, SC 0.17.0    |
| Angular, build      | 22.2.7, `@angular/build` 22.2.7                                      | 22.2.3, 22.1.8                          |
| Analog              | platform, plugin, Nitro plugin 2.9.7; router 2.8.1                   | 2.7.2; Nitro plugin 2.9.6; router 2.7.2 |
| Nitro / H3          | 2.13.6 / 1.15.11                                                     | 2.13.4 / 1.15.11                        |
| Vite / Rolldown     | 8.3.8 / 1.2.16                                                       | 8.3.0 / 1.2.0                           |
| TypeScript          | 6.0.3 and 5.9.2                                                      | same                                    |
| Wrangler / workerd  | 4.161.0 / 1.20261110.1                                               | 4.135.0 / 1.20260918.1                  |
| tslib / zod         | 2.9.1 / 4.6.7                                                        | 2.8.1 / 4.6.5                           |
| Toolchain           | Node 22.23.1, npm 10.9.8, Playwright 1.65.0 (Chromium 158.0.8127.18) | Playwright 1.62.1                       |
| Compatibility       | 2026-09-21, no flags                                                 | same                                    |
| Consumer lock       | 832 packages, digest `9f27f87c…`                                     | 869 packages                            |
| TypeScript 5.9 lock | 86 packages, digest `22703d05…`                                      | 80 packages                             |
| Fixture digest      | `19d8e3e8…` (includes the S-1 probe)                                 | `f2ba99e0…`                             |

The integrities in `candidate.json` were written by the capture from the downloaded tarballs, each checked against
the registry and the lockfile; none was edited by hand. The frozen run regenerated both manifests, matched them to
the captured ones, ran `npm ci` on both locks and repeated the full Node and workerd verification. Analog 0.13.0
has the same dependencies as 0.12.1, so the lock changes come from the framework tuple. The historical candidate
stays in git at `d85a60c`.

On this branch the frozen and registry consumers also passed on hosted Linux (Extended jobs 139502870981 and
139502870465), and the registry tuple was deployed to Cloudflare Pages (45699513690).

## Upgrade and rollback

`DEFAULT_PAIR` (`tools/server-components/lib/upgrade-rollback.ts`) moved to the two latest server-components
minors on the published analog:

| Arm | core  | analog     | server-components | build id              |
| --- | ----- | ---------- | ----------------- | --------------------- |
| A   | 0.2.2 | **0.13.0** | 0.16.0            | `upgrade-a-2026.11.6` |
| B   | 0.2.2 | **0.13.0** | 0.17.0            | `upgrade-b-2026.11.7` |

Both arms install the same consumer source and both carry the real `/ssr` entry (since 0.16.0), so the pair needs
no recipe bridge. Only server-components differs, and only its browser assets make skew meaningful.

| Run                                              | Where                                         | Result      |
| ------------------------------------------------ | --------------------------------------------- | ----------- |
| `pnpm test:full-stack-registry-upgrade-rollback` | local (macOS arm64)                           | PASS, 536 s |
| Extended job 139502870862                        | hosted Linux, Node + workerd + rehearsal      | PASS        |
| Cloudflare `source=upgrade-rollback` 45698741693 | deployed, preview alias `m5-upgrade-rollback` | PASS        |

The deployed run deployed A, verified it, deployed B, drove stale clients both ways and restored A from its
retained artifact. Covered: old browser on the new deployment and new browser on the old one (D5 and D8),
mismatched build identities refused before hydration, exactly one bounded reload when the cache converges and
"exhausted" without a loop when it does not, A's immutable assets served after B, retained-artifact rollback,
the protected tenant matrix and read receipts on every release (request and authorization isolation), and the
public-surface confidentiality scan. The strict console validation of #197 is unchanged: only the exact URLs the
stale deployment answers with 404 are accepted, any other console error fails.

**Analog 0.12.1 → 0.13.0 as its own scenario.** Analog ships no browser asset, so an Analog-only pair proves
server-side compatibility of one consumer source across the patch line, not deployment skew. It was run locally
with `STRATA_UPGRADE_A_ANALOG_VERSION=0.12.1` and server-components 0.17.0 on both arms; see
[Local verification](#local-verification) for its result. It is not a default and not an RC row.

## S-1 and S-2 from installed packages

The S-1 runtime contract was only exercised on the workspace Analog fixture (`pnpm test:analog-headers`). The
full-stack consumer fixture now registers the package README's pattern:

- `/api/request-origin/pinned/*` with `publicOrigin: "https://consumer.strata-qualification.example"` and the
  README's consumer-owned same-origin guard;
- `/api/request-origin/transport/*` without `publicOrigin`.

`httpSuite` (`tools/server-components/lib/full-stack-verify.ts`) then checks, black-box: `publicOrigin` is
`request.url.origin` whatever `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port` and `Forwarded` say; the
routed path and the exact query string (`?b=2&a=one%20two&a=three`) are kept; the guard answers 204 only for the
`publicOrigin` and 403 for the transport origin, a forwarded spoof and a missing `Origin`; without `publicOrigin`
the origin is what the runtime received and forwarded headers do not change it. On a local Node socket a
malformed `Host` (`evil host!`) yields `http://strata.invalid` with path and query kept, and cannot displace
`publicOrigin` (`tools/server-components/raw-response.test.ts` covers the raw-response decoding).

It runs wherever the installed analog declares the contract, and is mandatory for a source-packed candidate:

| Runtime                    | Packed (this checkout) | Registry 0.13.0    | Frozen `e04b7bb1`    |
| -------------------------- | ---------------------- | ------------------ | -------------------- |
| Nitro `node-server`, local | PASS                   | PASS               | PASS                 |
| Node production process    | PASS (local, hosted)   | —                  | PASS (local, hosted) |
| Local workerd              | PASS                   | PASS               | PASS                 |
| Deployed Cloudflare Pages  | PASS (45698725389)     | PASS (45699513690) | —                    |

On deployed Pages the transport origin was the deployment URL itself
(`https://acd34f7f.strata-fullstack-qualification.pages.dev`), and forwarded headers sent by the client did not
reach `request.url`. **Not covered:** a real TLS-terminating reverse proxy in front of Node. None is available
here; the expected outcome (transport origin `http://…`, failing a same-origin check closed unless `publicOrigin`
is set) is unit evidence only and is not claimed as deployed.

S-2: `src/check/analog-contract-example.ts` compiles from the **published** 0.13.0 declarations (registry and
frozen consumers, TypeScript 6.0.3 and 5.9.2, `skipLibCheck: false`), every `@ts-expect-error` still finds its
error, and the public-API inventory now matches the registry with `ControllerConstructor` present. The
zero-argument registrations of the fixture are unchanged and still pass.

## Production, security and duplicate installations

| Scenario                                        | Evidence on this branch                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Node production, source-packed and frozen       | hosted jobs 139502870960, 139502871006: PASS; 10 rounds × 2000 requests, RSS flat (227664 → 226364 KiB, 222304 → 224152 KiB) |
| Adversarial source mutation (full suite)        | hosted job 139502870870: PASS; four mutations rejected, positive controls survived where expected                            |
| `/ssr` with duplicated installations            | hosted job 139502870826: PASS                                                                                                |
| Production SSR integrity, 10 independent builds | hosted job 139502871162: PASS                                                                                                |
| Multi-isolate authorization, deployment skew    | local, see below; PR CI 45699565752                                                                                          |

Hosted Linux is a production _process_, not a persistent Node deployment. Local workerd says nothing about
Cloudflare isolate cold start or memory. Both limits stand.

## Performance

Extended 45698718670, workflow defaults (`STRATA_PERF_REPS=3`, `BUILD_REPS=3`, `REQUESTS=200`, `WARMUP=50`,
`CONCURRENCY=8`), compared with the last qualified run 42374195018 (2026-11-07, `efff41c`). Arm D is full Strata,
A the native baseline.

| Profile                  | SC browser gzip (budget 5120 B) | Controllers browser | D browser JS raw  | A Worker raw           | D − A Worker raw |
| ------------------------ | ------------------------------- | ------------------- | ----------------- | ---------------------- | ---------------- |
| 1 island, 1 controller   | 4631 → **4623 B**               | 0 B                 | 280.4 → 281.5 KiB | 722.2 → **1571.6 KiB** | 33.6 → 34.8 KiB  |
| 3 islands, 1 controller  | 4424 → **4416 B**               | 0 B                 | 282.5 → 283.6 KiB | 727.7 → 1577.1 KiB     | 32.0 → 33.2 KiB  |
| 3 islands, 8 controllers | 4424 → **4416 B**               | 0 B                 | 282.5 → 283.6 KiB | 756.5 → 1605.8 KiB     | 31.4 → 32.7 KiB  |

Every arm passed hydration, interaction and replay on Node and workerd; the "island-replay-lost" negative control
was rejected. No budget was changed.

**The material difference is not Strata's.** The Cloudflare Worker graph more than doubled in arm A, which
contains no Strata package, while Strata's own Worker cost (D − A) moved by about 1 KiB. #197 found the cause in
the install: Analog router 2.8.1 needs its `@analogjs/content` peer chain in the server bundle, which the
Cloudflare preset cannot leave external. The 441 KiB gzip Worker (arm A) stays well inside the Pages Functions
limit, but applications on this tuple should expect it. The Node server graph grew by about 10 KiB in every arm,
and builds took about 1.7 s longer in every arm on the hosted runner; latency is informational and has no
threshold. Browser bytes moved by about 1 KiB raw in all arms (framework).

The local repetition of the four arms, the comparison and the scaling profile is in
[Local verification](#local-verification).

## Angular peer range

`@strata-sc/server-components` 0.17.0 declares `@angular/*` `^22.1.7`. The frozen baseline and every fixture use
22.2.7; nothing runs 22.1.7 any more. The range is unchanged: narrowing it is a package change, which would need
another publish and invalidate the baseline captured here, and widening it is not supported by evidence. The RC
contract is the exact tuple, and [COMPATIBILITY](../COMPATIBILITY.md#rc0-support-contract) says so. Whether the
RC manifests should declare `>=22.2.7 <22.3.0` belongs to the RC entry review.

## Local verification

macOS arm64, Node 22.23.1, pnpm 10.30.1, run sequentially on the tree of `ddbe4f4` (= `4888fe6`). **Environment caveat:** unrelated
processes kept the machine's load average between 30 and 47 for the whole session, so local durations and
latencies are not performance evidence; byte counts and correctness are. Every failure below was investigated;
none is a Strata runtime defect.

| Command                                                                                                   | Result                      | Note                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                          | PASS                        |                                                                                                                                                                                              |
| `pnpm format:check`                                                                                       | PASS                        | first run flagged this report while it was being written; clean since                                                                                                                        |
| `pnpm lint`                                                                                               | PASS                        | 0 errors                                                                                                                                                                                     |
| actionlint 1.7.12, CI flags                                                                               | PASS                        |                                                                                                                                                                                              |
| `pnpm typecheck`, `pnpm build`, `pnpm test`                                                               | PASS                        |                                                                                                                                                                                              |
| `pnpm test:ci`, `pnpm test:release`, `pnpm test:performance-tools`                                        | PASS                        |                                                                                                                                                                                              |
| `pnpm test:full-stack-package-consumer` (packed)                                                          | PASS                        | S-1 on Node and workerd; the first run failed only the new raw-socket probe, which did not de-chunk the body (fixed, unit-tested)                                                            |
| `STRATA_CANDIDATE_CAPTURE=… pnpm test:full-stack-registry-consumer`                                       | PASS                        | the capture                                                                                                                                                                                  |
| `pnpm test:full-stack-frozen-candidate`                                                                   | PASS                        | `npm ci` of both captured trees                                                                                                                                                              |
| `pnpm test:full-stack-registry-upgrade-rollback`                                                          | PASS                        | 0.16.0 → 0.17.0 on analog 0.13.0                                                                                                                                                             |
| Analog 0.12.1 → 0.13.0 transition (same runner, `STRATA_UPGRADE_*`)                                       | FAIL, see below             |                                                                                                                                                                                              |
| `pnpm test:node-production`                                                                               | FAIL, see below             |                                                                                                                                                                                              |
| `pnpm test:node-production:frozen`                                                                        | PASS                        | S-1 included                                                                                                                                                                                 |
| `pnpm test:full-stack-multi-isolate`                                                                      | PASS                        |                                                                                                                                                                                              |
| `pnpm test:full-stack-adversarial-security` (full)                                                        | PASS                        |                                                                                                                                                                                              |
| `pnpm test:server-component-ssr-duplicate-install`                                                        | PASS                        |                                                                                                                                                                                              |
| `pnpm test:consumer`                                                                                      | BLOCKED, as committed       | AC2 only: the upstream `h3` declaration blocker of `@strata-sc/h3` (SPEC-001/002); acceptance verdicts identical to the committed report                                                     |
| `pnpm test:consumer:types`, `pnpm test:package-consumer`                                                  | PASS                        |                                                                                                                                                                                              |
| `pnpm test:analog-packed-di-consumer`                                                                     | PASS                        |                                                                                                                                                                                              |
| `pnpm test:analog`, `-streaming`, `-headers`, `-forms`, `-correlation`, `-observability`                  | PASS                        | `test:analog` recorded "every recorded expectation held"                                                                                                                                     |
| `pnpm test:server-components`, `-navigation`, `-defer`, `-server-only`                                    | PASS                        |                                                                                                                                                                                              |
| `pnpm test:server-component-security`, `-request-context`, `-authorization`, `-failures`, `-ssr-response` | PASS                        |                                                                                                                                                                                              |
| `pnpm test:server-component-package-consumer`                                                             | PASS                        |                                                                                                                                                                                              |
| `pnpm test:server-component-installed-island`                                                             | FAIL, see below             |                                                                                                                                                                                              |
| `pnpm test:server-component-deployment-skew`, `-optimized-deps`, `-dev`                                   | PASS                        |                                                                                                                                                                                              |
| `pnpm test:full-stack-deployed-cloudflare` (local rehearsal, no deployment)                               | PASS                        | S-1 on workerd                                                                                                                                                                               |
| `pnpm test:server-components:cloudflare`, `:deployed-cloudflare` (local)                                  | PASS                        |                                                                                                                                                                                              |
| `pnpm www:build`, `pnpm www:build:cloudflare`, `pnpm test:www:server-components`                          | PASS                        |                                                                                                                                                                                              |
| `pnpm www:test`                                                                                           | PASS                        | the first run failed the public-docs sync check after an edit of the published COMPATIBILITY section; that edit was withdrawn (see Merge state) and the check passes on the documentation PR |
| `pnpm www:test:e2e`                                                                                       | PASS against our own server | the default run reused an unrelated Next.js server already on port 3000 (`reuseExistingServer` outside CI); 7 of 7 with `STRATA_WWW_BASE_URL` on a free port                                 |
| `pnpm relay:build`, `pnpm relay:test`, `pnpm test:relay:server-components`                                | PASS                        |                                                                                                                                                                                              |
| `pnpm relay:test:e2e`                                                                                     | FAIL, see below             |                                                                                                                                                                                              |
| `pnpm release:state`                                                                                      | `ALREADY_PUBLISHED`         |                                                                                                                                                                                              |
| `pnpm release:verify`                                                                                     | PASS                        |                                                                                                                                                                                              |
| `pnpm release:rc:rehearse`                                                                                | PASS, 15 of 15              | from the 0.x tree, #198's empty Changeset included                                                                                                                                           |
| `pnpm release:rc:check --phase=pre`                                                                       | NO-GO, exit 1               | correct: no candidate, no baseline, every row NOT RUN                                                                                                                                        |
| Performance, one and three islands, comparison, scaling, registration                                     | running                     | hosted Extended is the performance evidence, see [Performance](#performance)                                                                                                                 |

**Failures, investigated.**

- **Analog 0.12.1 → 0.13.0 transition.** Two of three failures were mine: the build ids I passed contained
  package versions, which the runner refuses by design. The third: after rollback to arm A on local workerd,
  "the reader is released exactly once after the failure" missed its 5 s settle window. The safety property held
  in the same output (opened 10, closed 10, cleanups 10, nothing open); the window waits for Wrangler 4.161.0's
  dev-proxy replay count to appear in its log. The same phase passes in the default pair locally, on hosted
  Linux and deployed. Rerun: pending.
- **Node production, source-packed.** One gate: late RSS growth 162096 → 206624 KiB (ratio 1.27, limit 1.25).
  Rounds 1 to 6 ran at 200 to 300 req/s with a 300 ms p95 SSR latency, then throughput rose fivefold and RSS rose
  with it; rounds 8 to 10 were flat (200752, 206864, 206624 KiB). The frozen run on the same machine passed, and
  both hosted runs were flat (227664 → 226364 KiB, 222304 → 224152 KiB). The limit was not changed. Rerun: pending.
- **Installed island, dev server.** After an npm upgrade, `vite --force` was given a fixed 1.5 s to write
  `.vite/deps`; under this load it had written nothing ("none", not a stale v1). Dev-server only; the suite
  passed in hosted PR CI on this head. Rerun: pending.
- **Relay e2e.** Playwright's 60 s web-server start-up timeout expired while the Relay build ran under load;
  `pnpm test:relay:server-components`, which builds and drives the same application, passed. Rerun: pending.

## Hosted verification on this branch

All dispatched on `stabilize/rc0-production-requalification` at `ddbe4f4`, whose tree is the candidate's. They are
still branch evidence: the RC gate reads each row from a run on `main`.

| Run         | Workflow                                                                    | Head      | Result                                                                                        |
| ----------- | --------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| 45699565752 | CI (pull_request)                                                           | `ddbe4f4` | success, `Verify` green                                                                       |
| 45699565830 | Verify published Server Components (pull_request)                           | `ddbe4f4` | success                                                                                       |
| 45699565701 | Entwine docs (pull_request)                                                 | `ddbe4f4` | success                                                                                       |
| 45698718670 | Extended checks, `suite=all`, `islands=both`                                | `ddbe4f4` | success, 13 of 13 jobs                                                                        |
| 45698725389 | Qualify Full-Stack Strata on Cloudflare (packed)                            | `ddbe4f4` | success                                                                                       |
| 45699513690 | Qualify Full-Stack Strata on Cloudflare (registry), 0.2.2 / 0.13.0 / 0.17.0 | `ddbe4f4` | success                                                                                       |
| 45698741693 | Qualify Full-Stack Strata on Cloudflare (upgrade-rollback)                  | `ddbe4f4` | success                                                                                       |
| 45698733270 | Qualify Full-Stack Strata on Cloudflare (registry)                          | `ddbe4f4` | cancelled by the workflow's concurrency group (one pending run), re-dispatched as 45699513690 |

The Extended RC-readiness job printed `VERDICT: NO-GO` as a report and exited 0, as designed; its rehearsal went
from the 0.x state (0.2.2, 0.13.0, 0.17.0) to `1.0.0-rc.0` for all three and to `rc.1` after a one-package fix,
with `latest` untouched. Deployments went only to `strata-fullstack-qualification`; nothing touched `strata-www`,
DNS, routes or credentials.

## After the merge of #198

Observed on `main` at `4888fe6`, read from the API on 2026-11-26:

| Run         | Workflow               | Result                                                                                                       |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| 45703207134 | CI (push)              | success, `Verify` green: the `ci-verify` proof                                                               |
| 45703207058 | Entwine docs (push)    | success                                                                                                      |
| 45704889373 | Release (workflow_run) | success; `ALREADY_PUBLISHED`, every publish step skipped (the empty Changeset publishes nothing)             |
| 45704889421 | GitHub Pages redirect  | failure in `actions/deploy-pages` ("Deployment failed, try again later"), GitHub-side; isolated from Release |

Release 45704889373 is not a publication, so it is not `release-pipeline-observed` evidence; 45694359277 stays the
proof. Extended and the three Cloudflare qualifications have not run on `main`; this work did not dispatch them.

## RC evidence matrix

The ledger (`tools/release/rc-evidence.json`) is unchanged: `candidate`, `baseline` and `published` stay `null`
and every row stays `NOT RUN`. What each pre row can cite:

| Id                          | Status                                         | What closes it                                                                            |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ci-verify`                 | proof exists: CI 45703207134 (push, `4888fe6`) | recorded in the ledger PR                                                                 |
| `release-pipeline-observed` | proof exists: Release 45694359277              | recorded in the ledger PR; valid while `tools/release/**` and `release.yml` are unchanged |
| `baseline-frozen`           | branch PASS; main run missing                  | Extended `suite=all` on `main`                                                            |
| `baseline-deployed`         | branch PASS; main run missing                  | Cloudflare `source=registry` on `main`                                                    |
| `baseline-upgrade-rollback` | branch PASS; main run missing                  | Cloudflare `source=upgrade-rollback` on `main`                                            |
| `island-interaction`        | branch PASS; main run missing                  | Extended `suite=all`, `islands=both`                                                      |
| `performance-scaling`       | branch PASS; main run missing                  | same Extended run                                                                         |
| `ssr-duplicate-install`     | branch PASS; main run missing                  | same Extended run                                                                         |
| `node-production-source`    | branch PASS; main run missing                  | same Extended run                                                                         |
| `adversarial-security`      | branch PASS; main run missing                  | same Extended run                                                                         |
| `deployed-source-packed`    | branch PASS; main run missing                  | Cloudflare `source=packed` on `main`                                                      |
| `prerelease-rehearsal`      | branch PASS; main run missing                  | same Extended run                                                                         |
| `support-contract-review`   | pending maintainer authorization               | the maintainer's merge of the ledger PR                                                   |
| `rc-*` (five post rows)     | NOT RUN: no RC exists                          | SPEC-004 step 7                                                                           |

## Remaining RC blockers

| Item                                                    | Kind                                       |
| ------------------------------------------------------- | ------------------------------------------ |
| Ten candidate- and tuple-bound pre rows                 | missing evidence: the main dispatches      |
| Ledger PR, `pnpm release:rc:check` GO                   | missing evidence until those runs exist    |
| `support-contract-review`                               | pending maintainer authorization           |
| RC entry (`fixed` group, three `major`, `pre enter rc`) | pending maintainer authorization, after GO |
| Post rows                                               | pending publication of RC0                 |

No actual runtime defect is open. If a package source change becomes necessary before the RC, the candidate moves
to that commit and the source-packed rows are taken again; the baseline rows stay bound to `4888fe6`.

## Remaining GA blockers

Unchanged by this work, and none may be accepted for GA: real-application adoption (a separate development),
persistent Node deployment, Cloudflare cold start and memory, issue #117 transitions, and every PARTIAL item of
[RELEASE-1.0](../RELEASE-1.0.md). A synthetic fixture passing does not tick a GA item.

## Limitations kept explicit

Streaming SSR; Router activation into Server Component subtrees; consumer-owned Angular JIT DI and `serverFn` on
workerd; the H3 v2 adapter (`@strata-sc/h3` private); client-disconnect cancellation; confidentiality of unmarked
dependencies; persistent Node deployment; Cloudflare cold start and memory; S-1 behind a real reverse proxy; a
single qualified Angular version inside a wider declared range.

## Next steps

Candidate `<M>` = `4888fe6cfa6ece91901f80b243f66fcbd3358b22`. Dispatch on `main` while it differs from `<M>` only in
documentation, and before anything under `.changeset/` changes on `main`:

```sh
gh workflow run extended.yml --ref main -f suite=all -f islands=both
gh workflow run full-stack-deployed-cloudflare.yml --ref main -f source=packed
gh workflow run full-stack-deployed-cloudflare.yml --ref main -f source=registry \
  -f core_version=0.2.2 -f analog_version=0.13.0 -f server_components_version=0.17.0
gh workflow run full-stack-deployed-cloudflare.yml --ref main -f source=upgrade-rollback
```

Dispatch the three Cloudflare runs one at a time: the workflow's concurrency group keeps a single pending run and
cancels an older pending one. Then, in a PR that changes only the ledger and documentation (SPEC-004 step 4):
`pnpm release:rc:check --print-candidate=<M>` for `candidate`, `baseline` from
`tests/full-stack-candidate/candidate.json` with harness `<M>`, each row with its run id, `ci-verify` with CI
45703207134 and `release-pipeline-observed` with Release 45694359277. If that review revises the published RC0
support contract (S-1 deployed evidence, the Angular peer note), the website copy changes with it and the candidate
must move to that commit, so those edits are best made together with any other change that already moves it. The
maintainer's merge of the ledger PR is `support-contract-review`; `pnpm release:rc:check` must then print GO on
`main` before the RC entry.
