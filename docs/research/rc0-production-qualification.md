# RC0 production qualification

Date: 2026-11-06. Branch `stabilize/rc0-production-qualification`, PR #177. Starting `main`:
`ff3f1a4e94cd632dec8141b39113a759cfb19cb2`. Candidate code SHA: `ea580f018a43b7cf6493f0927844f7002600788d`
(later commits on the branch change documentation only).

Evidence levels, never interchangeable: UNIT, LOCAL NODE, LOCAL WORKERD, PACKED CONSUMER, PUBLISHED REGISTRY,
HOSTED CI, PRODUCTION PROCESS (a real production build and process on a hosted runner), DEPLOYED (a public
Cloudflare endpoint), REAL APPLICATION.

## Verdict

**RC0: NO-GO today, with a short mechanical path to GO.** Nothing found blocks an RC technically. What blocks it
is that the fixes live in this branch: the corrected release pipeline has not published anything yet, and the
`/ssr` fix is in no published version. See [Blockers](#remaining-blockers-ranked).

This does not tick any item in [RELEASE-1.0](../RELEASE-1.0.md). The matrix stays **PASS 1, PARTIAL 27, BLOCKED
0, NOT RUN 4**.

## Candidates

Two candidates, never to be confused. They can share a version string and differ in content: at `066bd13`
source-packed server-components 0.15.0 had integrity `sha512-Q++0…`, published 0.15.0 `sha512-R2Sj…`.

|                        | A. PUBLISHED                                     | B. SOURCE-PACKED                                                                     |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Status                 | on npm                                           | **not published**; `pnpm pack` of the candidate SHA, installed outside the workspace |
| core                   | 0.2.2 `sha512-Xr6bMt7f…`                         | 0.2.2                                                                                |
| analog                 | 0.12.1 `sha512-0ytlP1rp…`                        | 0.12.1                                                                               |
| server-components      | 0.16.0 `sha512-4MRsUyFq…`                        | 0.16.0 manifest plus the pending `/ssr` Changeset                                    |
| Frozen tree            | `893a15145303f585`, 869 packages, TS 5.9 tree 80 | floats with the fixture manifest                                                     |
| `/ssr`                 | the real export, not the recipe                  | the real export, with the new protocol                                               |
| Graph hardening (#175) | included: it shipped in 0.16.0                   | included                                                                             |
| `/ssr` duplicate fix   | **not included**                                 | included                                                                             |

Published history in this sprint: `402f33e953f9a04b` (server-components 0.14.0, recipe) →
`667e98a624fede7f` (0.15.0, 464 checks, first with the real export) → `893a15145303f585` (0.16.0, 461 checks).

Framework tuple of both: Angular 22.2.3, Analog 2.7.2, Vite 8.3.0, Nitro 2.13.4, H3 1.15.11, TypeScript 6.0.3 and
5.9.2, Node 22, Wrangler 4.135.0, compatibility date 2026-09-21, no flags, Chromium 151 through Playwright 1.62.1.

The maintainer merged the Version Packages PR #176 during this sprint, so 0.16.0 was published mid-run and the
branch merged `main` at `ba2f5ca`. The candidate was recaptured on it rather than left as a procedure.

### Recapturing after the next publish

```sh
STRATA_CANDIDATE_CAPTURE="$PWD/tests/full-stack-candidate" pnpm test:full-stack-registry-consumer
pnpm test:full-stack-frozen-candidate
gh workflow run "Qualify Full-Stack Strata on Cloudflare" -f source=registry
```

Then move `DEFAULT_PAIR` in `tools/server-components/lib/upgrade-rollback.ts` to the two latest minors and run
`source=upgrade-rollback`. A capture writes nothing unless the whole qualification passed.

## Publication visibility

### Finding

Release runs 42181130222 and 42206274309 failed at `Align npm dist-tags`. The earlier explanation, stale registry
reads, was incomplete. `npm publish` succeeds before npm has committed the version:

| Version                  | changeset "Successfully published" | npm `time[version]` | Commit delay |
| ------------------------ | ---------------------------------- | ------------------- | ------------ |
| server-components 0.14.0 | 21:12:54.9                         | 21:13:50.9          | 56 s         |
| server-components 0.16.0 | 10:56:34.9                         | 10:57:50.0          | 75 s         |
| server-components 0.15.0 | 07:30:08                           | 07:31:24.5          | 76 s         |
| analog 0.12.1            | 13:20:16                           | 13:21:52.6          | 96 s         |

The step gave up about 51 s after publishing, so it could not pass. Run 42206274309 is a live reproduction: the
failure was predicted before it ran, because `main` still had the old tooling.

Endpoints differ. `/<name>/<version>` and `/-/package/<name>/dist-tags` answer uncached (`cf-cache-status:
DYNAMIC`). Both packuments carry `cache-control: public, max-age=300`, and `npm install` reads the abbreviated one.

### Second defect: the failure was not recoverable

A nonempty Changeset classifies the next run as `VERSION_REQUIRED`, which skipped alignment. That is why `next`
is still 0.14.0 after two releases. The registry gate of the failed run never ran either.

### Fix

| Requirement                           | Result                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Separate publication from propagation | three states: ACCEPTED, COMMITTED, PROPAGATED, reported separately                                      |
| Authoritative metadata and integrity  | decisions read the uncached endpoints; tarballs are hashed against `dist.integrity`                     |
| Bounds from measurements              | commit 635 s (6.6× the worst), tag write 110 s, propagation 495 s (over `max-age=300`)                  |
| Never report success on failed checks | verify fails on lag, integrity, provenance or dependency problems                                       |
| Never republish                       | classification reads the uncached version, so a stale packument cannot look unpublished                 |
| Never move tags backwards             | unchanged policy, now planned from uncached tags                                                        |
| Provenance                            | required for packages the run published; `changesets/action` flow unchanged                             |
| Exact SHA and aggregate Verify        | `authorize.ts` and `verify-run.ts` unchanged                                                            |
| Idempotent recovery                   | a repair step runs before versioning; a repaired tag also triggers the skipped registry gate            |
| Diagnostics                           | `VISIBILITY LAG` (re-run, do not republish), registry outage, never-accepted publish, `PROPAGATION LAG` |

Added after the prerelease rehearsal: a stable `1.x` is `BLOCKED` unless the repository variable
`STRATA_RELEASE_STABLE_1_0` is `authorized`.

Evidence: UNIT (`publication-visibility.test.ts` replays run 42181130222 on a virtual clock; the old bound fails,
the new one passes). Live read-only: `verifyPublication` reported exactly the `next` drift, with integrity and
provenance passing on all three packages. **Not observed: a real publish through the new code.** That is blocker 1.

Issue #117 stays open. Its hosted pending and stale-main transitions have still not been observed, and nothing
here simulates them into evidence.

## SSR installation integrity

The module-level `WeakMap` split across two installed copies, so a failed render answered HTTP 200.

Angular creates `ErrorHandler` lazily (`INTERNAL_APPLICATION_ERROR_HANDLER` calls `injector.get(ErrorHandler)` on
the first error), so a healthy render cannot reveal a missing handler. That rules out detection inside the handler.

The fix keeps the state per request: a non-enumerable slot on the response object, keyed through `Symbol.for`, with
a protocol number, removed before the wrapper returns. Only the name is global. The module now holds no state, and
no Angular private API is used. An environment initializer proves the provider took part in every render.

Production Nitro build, real tarballs, nine arms (`pnpm test:server-component-ssr-duplicate-install`):

| Arm                                             | Healthy | Failed render | Meaning               |
| ----------------------------------------------- | ------- | ------------- | --------------------- |
| Single copy (control)                           | 200     | 500           | contract intact       |
| Published ×2, one Angular (negative control)    | 200     | **200**       | the bug               |
| Published ×2, second Angular (negative control) | 200     | **200**       | the bug, other cause  |
| Candidate ×2, second Angular                    | 500     | 500           | refused               |
| Candidate ×2, one Angular                       | 200     | 500           | **works**             |
| Candidate ×2, one Angular, local workerd        | 200     | 500           | **works**             |
| New wrapper, old provider                       | 500     | 500           | refused               |
| Old wrapper, new provider                       | 500     | 500           | refused               |
| Wrapper or provider missing                     | 500     | 500           | refused, one arm each |

**Verdict: resolved at runtime; no build-time guard was needed.** Remaining limits: two copies both at ≤ 0.16 cannot
be detected, and an old wrapper beside a new provider that loads a second Angular still answers 200, because neither
half can reach the other. Behaviour change: a composition missing one half now fails every request. The inner
render must be a real Angular render, not a cache of documents.

Process note, kept because it shaped the tool: the first runs mixed the two layouts. A `String.replace` hit a comment
in `vite.config.ts`, so the "bundled" arms were external and looked like product failures. A positive control now
fails if an arm's layout is not the one it declares.

## Security and runtime

C2 graph protections: mandatory suites and the frozen candidate pass on tarballs, Node and workerd, including
output-leak scans. PR #175 was not rewritten. Published 0.16.0 now carries it.

C3 lifecycle audit: Analog already covers cleanup on every rejected-input path, LIFO order, failure then success,
413 connection reuse and guards (`request-cleanup`, `body-limit-connection`, `register-controllers` tests). No Analog
test was added; more would be noise. The concrete gap was the `/ssr` slot lifecycle, now covered by 13 unit tests:
slot removal on every path, a retained contract refusing late records, interleaved failure and success, nesting.

Two test defects found and fixed, neither a product defect:

- The island smoke re-clicked every 150 ms, so a cold workerd isolate produced a second legitimate request and a
  false `2 API request(s)` failure in Extended 42203589519. It now waits for an in-flight request. The exactly-one
  assertion is unchanged.
- Changesets hangs on a shallow clone with no remote, which timed out the RC job. It now uses full history, a
  timeout, and refuses a shallow checkout with a clear error.

## Node production

**PRODUCTION PROCESS, not DEPLOYED NODE.** No authorized persistent Node target exists. `pnpm test:node-production`
runs the real `dist/analog/server/index.mjs` on GitHub-hosted Linux. Extended 42203589519, Node 22.23.4, linux-x64,
one process, 20,000 mixed requests, 12 in flight, after the full functional suites:

|                                | Source-packed    | Frozen published  |
| ------------------------------ | ---------------- | ----------------- |
| Listen / first SSR / first API | 117 / 194 / 9 ms | 112 / 163 / 18 ms |
| RSS start → plateau            | 85 → 216 MiB     | 85 → 213 MiB      |
| Open descriptors               | 48 → 46          | 48 → 47           |
| Last round SSR / API p95       | 22.4 / 8.4 ms    | 16.1 / 5.8 ms     |
| Stop                           | 24 ms            | 22 ms             |
| Failing checks                 | 0                | 0                 |

Every response matched its own request, including cross-tenant 403, unauthenticated 401 and render-failure 500
traffic. RSS flattens after about 8,000 requests, which is consistent with no leak at this volume and proves nothing
about days of uptime. Latency is an observation on a noisy runner, not a budget.

## Cloudflare deployed

Existing workflow and isolated project `strata-fullstack-qualification` only; no project was created.

| Run         | Candidate                                                          | Result                                                                                                         |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 42203639702 | B source-packed at `066bd13`                                       | **GO**, 408 checks: controllers, SSR, island, confidentiality, `/ssr` 500 contract, concurrency                |
| 42204261334 | A published, server-components 0.15.0                              | **GO**, 405 checks                                                                                             |
| 42204751136 | A/B 0.14.0 → 0.15.0                                                | stopped before deploying: the older arm needs the recipe, so sources differed. Correct refusal; the pair moved |
| 42207006348 | A/B published 0.15.0 → 0.16.0, candidate code SHA line (`9e2bba9`) | **GO**: release A, release B and A's retained artifact, both arms on the real `/ssr`                           |

The deployed source-packed flow has no build-identity or stale-asset checks; those exist only in `upgrade-rollback`,
on published tuples. Retained-artifact rollback of a source-packed candidate is therefore NOT RUN.

Reruns on the candidate SHA are recorded in the [ledger](#ledger); see the pull request for final links.

## Performance

Browser budgets hold in Extended 42203589519: controllers add 0 B (limit 0 B), Server Components add 4.5 KiB gzip (limit 5.0 KiB). Cloudflare isolate cold start and Worker
memory stay **NOT MEASURED**: no supported tool exposes them. Node startup above is process startup, not an isolate
cold start.

## Support matrix

The contract is [COMPATIBILITY](../COMPATIBILITY.md#rc0-support-contract).

## Versioning and Changesets

One pending minor: `/ssr` integrity, because of the behaviour change above, giving server-components 0.17.0. The RC
is a separate decision ([SPEC-004](../specs/004-first-release-candidate.md)). The rehearsal found: three `major`
Changesets are required to reach `1.0.0-rc.0`; one-package fixes split the tuple without a `fixed` group; a stable
`1.0.0` had no guard. It also disproved an assumption: Changesets 3 moves consumed files to `.changeset/pre/`, so
the pre-mode classifier change first written here was unnecessary and was removed.

## CI

No mandatory job or command was added; `rc0` runs in Extended only. Run 42204608302 took 17.7 minutes of wall time
against the usual 10 to 12, while Extended, deployment and superseded runs shared the runner allowance, so it is not
a clean measurement.

## Remaining upstream limitations

Angular JIT on workerd; streaming SSR; client-disconnect cancellation without a transport signal; Router subtree
Server Component activation; private H3 v2 adapter and strict-type blockers (SPEC-002 stays upstream-blocked).

## Remaining blockers, ranked

1. **Release pipeline fix unobserved.** Merge this PR. Release should repair `next` and, after the Version PR,
   publish 0.17.0 without manual help. Failure here must stop the RC.
2. **`/ssr` fix unpublished.** Candidate A lacks it. Resolved by the same publish.
3. **Requalify the resulting tuple**: recapture, frozen, deployed `registry`, `upgrade-rollback`.
4. **Maintainer review of the support contract**, the input to the RC-entry PR.

`pnpm release:rc:check` prints the live version of this list.

## Exit criteria affected

Stronger, none ticked: failure behavior (#15), Node entry (#24), Cloudflare (#25), release and rollback (#26 area),
SemVer and prerelease handling, graph items (published now). Unchanged: every real-application criterion.

## Readiness assessment

An estimate, not a measurement: about 70 to 75% technically towards GA, up about 5 points this sprint, mostly from
one identified candidate, the production-process evidence, and a fail-closed `/ssr`. It is not 90%: four
real-application requirements have not started, and they are the ones most likely to find new defects. An RC is
close. GA depends on outside adoption, which more hardening here cannot replace.

## Ledger

`tools/release/rc-evidence.json` holds each mandatory check, with its status, link and candidate.
