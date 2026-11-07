# RC0 production qualification

Date: 2026-11-06. Branch `stabilize/rc0-production-qualification`, PR #177. Starting `main`:
`ff3f1a4e94cd632dec8141b39113a759cfb19cb2`. Candidate code SHA: `ea580f018a43b7cf6493f0927844f7002600788d`
(later commits on the branch change documentation only).

Evidence levels, never interchangeable: UNIT, LOCAL NODE, LOCAL WORKERD, PACKED CONSUMER, PUBLISHED REGISTRY,
HOSTED CI, PRODUCTION PROCESS (a real production build and process on a hosted runner), DEPLOYED (a public
Cloudflare endpoint), REAL APPLICATION.

## Update: RC0 release train (2026-11-07)

Start: `main` `3b497d9` (PR #180 merged). This section follows [SPEC-004](../specs/004-first-release-candidate.md)
step by step; earlier sections are the record of how the gate got here.

**Step 1, baseline published.** Release run
[42237367717](https://github.com/Andersseen/Strata/actions/runs/42237367717) on `3b497d9`, the first one through the
corrected pipeline, published `@strata-sc/server-components@0.17.0` with no manual help: `Version PR or publish to
npm`, `Align npm dist-tags` (`next` 0.16.0 → 0.17.0 after npm committed the version, six reads),
`Verify npm registry, tags and GitHub Releases` (PASS) and the registry consumer (0 failing checks) all succeeded. Read
back from npm on 2026-11-07:

| Package                        | Version | Integrity                                                                                         | `latest` / `next` |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------- | ----------------- |
| `@strata-sc/core`              | 0.2.2   | `sha512-Xr6bMt7funa/RtMhr/BTLX548alI8w5/tq/4QIgvk4INEc4nED5CweQUeEujPU6o9/NcJ1XFtqcXPNGjohkHFA==` | 0.2.2 / 0.2.2     |
| `@strata-sc/analog`            | 0.12.1  | `sha512-0ytlP1rpn5zNhUUtFo2gB6oQzvim8h9jxNBFwMYyavnnUqgHbZYauXeDQXX6Q16Aa/a+wLkMAcqwGIfqLmV4aw==` | 0.12.1 / 0.12.1   |
| `@strata-sc/server-components` | 0.17.0  | `sha512-SOrJTSac6qRhpI8cn3QL4Cr4jslHN0gwTHA9H9iSCepOHhVenzK/tpo0y0GbGh6JqoLd1/qBBx1QUj4uwMr/Og==` | 0.17.0 / 0.17.0   |

`npm audit signatures` verifies registry signatures and SLSA provenance attestations for all three. The installed
0.17.0 tarball exports `./ssr`, whose declarations return `EnvironmentProviders` and include the `"integration"`
phase.

**Step 2, baseline recaptured.** `DEFAULT_PAIR` moved to 0.16.0 → 0.17.0 (build ids `upgrade-a-2026.11.6`,
`upgrade-b-2026.11.7`). Locally, on macOS arm64 with Node 22.23.1:

| Command                                                                                             | Result                                                           |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `STRATA_CANDIDATE_CAPTURE="$PWD/tests/full-stack-candidate" pnpm test:full-stack-registry-consumer` | PASS, 0 failing; captured `983f7131e39574e0`                     |
| `pnpm test:full-stack-frozen-candidate`                                                             | PASS, 0 failing, `npm ci` of both trees                          |
| `pnpm test:full-stack-registry-upgrade-rollback`                                                    | PASS, 0 failing; local deployment rehearsal GO, DEPLOYED not run |

The installed `/ssr` entry is what the fixture imports; no recipe bridge applies at 0.17.0. The only transitive
change from `893a15145303f585` is Rollup 4.67.5 → 4.68.0. Local runs are LOCAL NODE, LOCAL WORKERD and CHROMIUM
evidence of the published artifacts; the gate counts only the hosted runs on the merge commit of this recapture.

**Sequence defect found and corrected (documentation only).** SPEC-004 made the RC-entry merge the candidate and
then asked for the prerelease rehearsal on it. The rehearsal performs the entry itself, and on the entry commit
`changeset pre enter rc` fails: "pre enter cannot be run when in pre mode" (reproduced locally on
`release/rc-entry`). A fix in `tools/release/` would reset `release-pipeline-observed` and force an artificial 0.x
publish. Instead the candidate is the recapture's merge commit, all candidate and baseline evidence is taken there,
and the entry follows the GO as a versioning-only change, the diff the gate already accepts between candidate
and publishing commit under `--publishing`. The real entry commit was versioned in a throwaway clone: all three
`1.0.0-rc.0`, analog's `@strata-sc/core` stays `workspace:*` (packed as the exact version), and the diff is
`.changeset/` plus manifests and changelogs only. The rehearsal fix is deferred until after RC0 publishes; see
SPEC-004, Risks.

## Update: qualification blockers closed (2026-11-06, branch `fix/rc0-qualification-reliability`)

Start: `main` `79f7764`. Published: core 0.2.2, analog 0.12.1, server-components 0.16.0; manifest 0.17.0 is
versioned (#179) and unpublished, because CI of `79f7764` failed. The sections below keep the first pass's record;
where they disagree, this one holds.

| Defect                           | Layer    | Cause                                                                               | Resolution                                                              |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `bind(): Address already in use` | harness  | numbers picked from the ephemeral pool, while Wrangler opens port-0 sockets from it | Wrangler binds port 0 and announces its port; no retry remains          |
| Orphan workerd after startup     | harness  | `stop()` ignored the group once its leader had exited                               | `stop()` reaps the process group and fails if anything survives SIGKILL |
| Double island request            | harness  | it clicked until the UI changed, and Angular queues early clicks for replay         | hydrated and replay proofs separated; exact counts                      |
| One-island smoke                 | harness  | it accepted any number of requests above zero                                       | the same exact proofs as three islands                                  |
| RC gate could say GO on one row  | tooling  | rows were only read if supplied; the candidate was compared with itself             | code catalog; verified proofs, identities and tuples                    |
| Rehearsal job could not fail     | workflow | `\| tee` without `pipefail`                                                         | `pipefail`                                                              |
| Analog G2 check on `main`        | harness  | **not determined**, see below                                                       | asserts the stated cause; prints the evidence if it recurs              |

### workerd startup

Run 42210806375's log cannot name the socket: colliding the HTTP port and the inspector port locally produced the
same message. Only those two sockets had caller-chosen numbers. `workerd` shows the rest at port 0 (`--socket-addr=entry=…:0`,
`--inspector-addr=…:0`, `--debug-port=…:0`), and the two processes and Wrangler's loopback servers hold about ten
listeners. `listen(0)` uses one parity of the ephemeral range, about 14,000 ports on Linux, so the harness's two
released numbers and Wrangler's own binds draw from one small pool. No sleep or fixed port fixes that. `--port 0
--inspector-port 0` removes the numbers, and the port is read from Wrangler's `Ready on` line.

`startPagesDev` in `tools/server-components/lib/wrangler.ts` is now the only way the tools start local workerd, and
`startWithPortRetry` is gone. Node and Vite servers still use `findFreePort`: they bind at once and open nothing
first, so the window is far smaller, but it is not zero. The Angular JIT characterization is unchanged. Regression:
`tools/server-components/wrangler-startup.test.ts`, which runs real Wrangler: the collision itself, a start with 64
ports held, three simultaneous instances, stop-one isolation, successive restarts, and group cleanup.

### Three islands

The first pass's hypothesis is now shown, and the defect is not in Strata. A directed run held the scripts, clicked,
released them, and logged DOM clicks and `fetch` calls in the page, on arms A (no Strata) and D, Node and workerd:

| Clicks before hydration | Clicks after | `fetch` calls, all four combinations |
| ----------------------- | ------------ | ------------------------------------ |
| 0                       | 1            | 1                                    |
| 1                       | 0            | 1                                    |
| 2                       | 0            | 2                                    |
| 1                       | 1            | 2                                    |

`provideClientHydration()` enables incremental hydration and with it event replay, so the SSR button carries
`jsaction="click:;"` and early clicks queue. The old loop saw no request and no change, and clicked again. A baseline run
reproduced the failure on **arm A**, which contains no Strata code. Replay bypasses `[disabled]`, so `k` early clicks
are `k` requests: correct for `k` interactions.

Rejected with evidence: duplicate handlers (one `fetch` per click on every arm), request duplication by the component
(same), and late observation (the count is now taken in the page and compared with the network).

Each page load now proves one thing, on one and three islands. **Hydrated**: wait for hydration without touching
the page, click once, and require one request and an unchanged neighbour. **Replay**: click with scripts held
(twice on the first island), require no request yet, and one effect per click afterwards. Assertions kept: SSR node
reuse, independence, no hydration errors, canaries. Negative controls added: `island-duplicate-request` and
`island-replay-lost`.

Repetition fixed in advance: 8 per arm and runtime on the three-island profile, with no stopping on success. Result:
64 of 64, LOCAL NODE and LOCAL WORKERD, darwin-arm64, on the builds where the old loop had just failed on arm A
workerd. The four deliberate faults were each rejected on those builds.

### Analog G2 on `main`

Run 42220794647 failed `G2 failure cause` with `traced: none` on `79f7764`, the same tree as passing PR run 42219627272. The check also required `tslib.es6.mjs` in Nitro's trace, which is not what it claims. 12 local builds all
traced `package.json, tslib.es6.mjs`, so the variation was **not reproduced and its cause is unknown**. It is also odd:
with no traced `tslib`, Node should reach the fixture's own copy, yet that run still classified G2-prod as failing, and
it left no log to explain why. The check now asserts its stated claim, the missing Node entry and the failed
render, and prints the server error and the traced packages whenever the trace differs. It stays an open item, in
[RISKS](../RISKS.md), and it is an upstream characterization, not a supported path.

### What the gate reads now

See [SPEC-004](../specs/004-first-release-candidate.md#how-a-verdict-is-computed). `release:rc:check` reports NO-GO, by
design, until the sequence there has run. The ledger no longer holds a candidate: the previous one predates these
changes.

## Verdict

First pass; superseded by the update above where they disagree.

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

One test defect found and fixed: Changesets hangs on a shallow clone with no remote, which timed out the RC job. It
now uses full history, a timeout, and refuses a shallow checkout with a clear error.

**Open, not explained: `availability: 2 API request(s), expected exactly 1`.** It failed the arm D (full Strata)
workerd smoke, repetition 1, in Extended 42203589519 and again in 42207479355. The second run already contained
the change that stops re-clicking while a request is in flight, so that change did not fix it, and this report's first
version wrongly recorded it as fixed. The current hypothesis is unproven: clicks before hydration are captured by
Angular's event replay and replayed afterwards, adding one request per early click. Until a run shows which clicks
produced which requests, a real double activation is not excluded. The exactly-one assertion stays.

**CI flake, diagnosed, not fixed:** main run 42210806375 failed with `bind(): Address already in use` in the packed
Angular DI consumer. `findFreePort` releases a port before workerd binds it. The suite passed on the PR, and Release
42212123291 correctly refused to run on the failed source.

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
| 42209412051 | A published, server-components 0.16.0                              | **GO**                                                                                                         |
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

No mandatory job or command was added; `rc0` runs in Extended only. Run 42207481386 at the candidate SHA took 11.1
minutes. Run 42204608302 took 17.7 minutes while it shared runners with Extended and deployments.

## Remaining upstream limitations

Angular JIT on workerd; streaming SSR; client-disconnect cancellation without a transport signal; Router subtree
Server Component activation; private H3 v2 adapter and strict-type blockers (SPEC-002 stays upstream-blocked).

## Local verification

Passed locally on the merged tree: build, lint, typecheck, format check, `pnpm test`, `test:ci`, every graph, runtime
and Analog suite, the packed Server Components, package, island, Angular DI and full-stack consumers. The run was
stopped before multi-isolate, adversarial smoke, deployment skew, Cloudflare rehearsal, website, Relay, Node production
and upgrade suites, because the shared checkout moved. Those passed in hosted CI or Extended, except as listed above,
and were not run locally on the final tree.

## Remaining blockers, ranked

First pass; `pnpm release:rc:check` prints the current list.

1. **Release pipeline fix unobserved.** Merge this PR. Release should repair `next` and, after the Version PR,
   publish 0.17.0 without manual help. Failure here must stop the RC.
2. **`/ssr` fix unpublished.** Candidate A lacks it. Resolved by the same publish.
3. **Requalify the resulting tuple**: recapture, frozen, deployed `registry`, `upgrade-rollback`.
4. **Unexplained double request** in the arm D workerd smoke, see above. It must be explained before an RC.
5. **Maintainer review of the support contract**, the input to the RC-entry PR.

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
