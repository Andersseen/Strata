# Pre-1.0 runtime hardening: CI, Cloudflare multi-isolate authorization, SSR failure contract

Date: 2026-11-05. Branch `stabilize/pre1-ci-edge-runtime-hardening`.
Starting main: `94347ea3b6a991ab68d7e5d1a0c9b397b26b3da5` (PR #171 merged). The final implementation SHA
is the head of the pull request that carries this report.

Evidence levels used below, never interchangeably: IMPLEMENTED, UNIT, LOCAL NODE, LOCAL WORKERD,
PACKED CONSUMER, PUBLISHED REGISTRY, HOSTED CI, DEPLOYED, REAL APPLICATION.

## Public package tuple

Verified on npm on 2026-11-05: `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.12.1,
`@strata-sc/server-components` 0.14.0. `latest` and `next` agree for all three (analog's `next` was
0.12.0 until Release run 42048951547 aligned it, below). Registry integrities are recorded in
`tests/full-stack-candidate/candidate.json`. No package version changes in this work.

## Starting failures

| Id      | Starting state                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| CI      | Mandatory CI 22.9–32.3 min wall; `consumers` (22–31 min) the critical path; main runs cancellable           |
| F6      | Deployed authorization verifier read per-isolate module counters back with a second request: DEPLOYED NO-GO |
| F7      | One Pages branch alias served the previous deployment after 3 correct readiness answers (1 of 4 runs)       |
| F9      | `strataDocumentNavigationGuard` seen once with 2 document requests on the public alias                      |
| #15     | BLOCKED: unexpected render failures answer HTTP 200 with an empty or half-rendered document                 |
| D       | Frozen candidate referenced analog 0.12.0; analog 0.12.1 (413 keep-alive fix) published but unqualified     |
| Release | Release run 42034642481 left analog `next` at 0.12.0; issue #117 open                                       |

## Verified root causes and changes

### CI (tooling only; [report](ci-acceleration.md))

Root cause: sequential commands inside five jobs, a full workspace build per job that most suites
discard, and apt font downloads (`playwright install --with-deps`) that stalled at ~24 kB/s for 9–10
minutes (runs 42043494173, 42046849111). Change: eleven measured jobs, package-only builds where
apps are not read, Chromium without apt (fallback on a failed launch, never triggered), a coverage
inventory enforced by `pnpm test:ci`, main runs never cancelled, `deploy-www` serialized. Result,
HOSTED CI: **10.2 min** wall for a full successful run (42055399997; 9.2 and 9.3 min on two others),
runner time 68–72 min versus a 64.5 min median (+5–12 %).

### F6: authorization observations across isolates (fixture and verifier; RESOLVED, DEPLOYED)

Root cause (verified): protected reads were counted in module state and read back by a separate
request (`/api/protected-read-count/:id`); Cloudflare routes that request to any isolate. A second,
previously hidden defect: the SSR "read count" was a constant rendered by the component, not an
observation; and Analog bundles the fixture module twice (Nitro bundle and Angular SSR renderer), so a
module-local ledger would never see SSR reads (found on LOCAL NODE: SSR receipts said 0 reads while
the page rendered private data).

Change (test-only): each protected request carries a fresh `x-fixture-read-observation` id; a fixture
Nitro plugin (public `request` / `beforeResponse` hooks) opens a ledger and puts the reads made while
serving that request on the same response as `x-fixture-read-receipt: <id>;reads=<n>;resources=<ids>`.
The read function takes the request's headers, so a caller cannot read unobserved. The store is keyed
by `Symbol.for` on `globalThis`: shared by both bundles, never by two isolates. The verifier requires a
well-formed receipt for its own id on every response; a missing, foreign, inconsistent or conflicting
receipt fails, and absence is never "zero reads". The cross-request endpoint is removed.

Negative controls: a live read-before-deny route (403, no data) must be caught by its receipt in every
runtime; unit tests (`read-receipt.test.ts`) reject a denied response with a read, a 200 without a
read, a cross-tenant read, a missing and a foreign receipt; a new adversarial source mutation reads the
resource in the guard before authorizing (every status and body stays correct) and the production
consumer rejects it (PACKED CONSUMER, Node + workerd + Chromium, `pnpm test:full-stack-adversarial-security`,
all four mutations rejected locally).

Reproduction (`pnpm test:full-stack-multi-isolate`, LOCAL NODE + LOCAL WORKERD, mandatory in CI): two
Nitro Node processes and one local workerd behind a deterministic round-robin router that records the
serving instance. The legacy protocol agrees with real reads on one instance (control), reads back 0
when the read-back reaches another instance (F6 reproduced) and 0 after the serving instance restarts;
the corrected matrix (API, SSR, 24 + 24 overlapping principals, live negative control) passes with its
requests distributed over all three instances. No sleeps.

DEPLOYED: every phase of runs 42058285983 (packed, `https://c3bd308b.strata-fullstack-qualification.pages.dev`,
branch `qualification-419359f71f5e`) and 42058305233 (published A/B, alias
`m5-upgrade-rollback.strata-fullstack-qualification.pages.dev`, phases D1 A, D3 B, D8 restored A) passed:
API and SSR receipts, 24 overlapping SSR principals, the live read-before-deny control.

### F5 residual (verifier; RESOLVED, DEPLOYED)

Deployed run 42053087187 (`e73fc39`) reported 1 and 4 "anomalous" Server Component bodies at 10 and 25
concurrent requests while recording no sample for any of them. Root cause: `round()` in
`full-stack-remote.ts` compared documents byte for byte while the classifier it calls uses F5's
canonical comparison of Angular's per-isolate `__nghData__` template ids. Fixed by the same comparison
(`bodyMatchesBaseline`, UNIT: template-id variance accepted; any other byte, request-id echo or canary
rejected). Next deployed run: 829 requests, 0 anomalies.

### F7: Pages branch-alias convergence (investigated; NOT REPRODUCED; platform contract unchanged)

Measured in 42058305233: each alias transition (deploy A, deploy B, restore A) served the expected
build after 3 readiness reads with 0 not-ready answers; every boundary on the alias carried the
expected build id; each deployment's immutable URL served the same build; A's immutable URL still served
A after B was deployed; 829 edge requests showed 0 anomalies without retries. Three transitions without
a stale answer do not prove global edge convergence and Cloudflare documents no atomic alias update.
Disposition (unchanged, now with more evidence): the contract is the immutable deployment artifact plus
build identity; mixed versions are refused (D5: B document with A's deployed scripts refused as
build-mismatch naming both builds; with recovery on, exactly one bounded reload when the edge
converges and "exhausted" without a reload loop when it does not). The readiness phase is the only
bounded retry; the qualification matrix has none.

### F9: double document request (investigated; NOT REPRODUCED; verifier classification fixed)

The application cannot start two assignments from one document: the guard calls
`StrataDocumentNavigator.go()` once and `go()` drops a second identical in-flight href. The verifier,
however, counted every navigation-type request, including redirect hops of one navigation and iframe
navigations. It now counts main-frame navigation chains (a redirect hop belongs to its chain); a second
chain, including a recovery reload, still fails, and a failure prints every matching navigation record
and the tab's skew-recovery record. Not reproduced in 5 deployed phases today (packed; D1, D3, D8; the
A/B run's navigation checks), nor locally. The original single observation stays unexplained; the next
one will be classifiable.

### SSR failure contract (#15; supported public seam found; fixture-qualified, DEPLOYED)

Investigated on the installed sources: Angular 22.2.3 (`renderApplication`, `ErrorHandler`),
`@analogjs/router` 2.7.2 in the external fixtures and 2.8.1 in the workspace (`render()`), Nitro 2.13.4
(`request`, `beforeResponse`), h3 1.15.11. Angular buffers the server render and reports every
unexpected error to the application's `ErrorHandler` (resolved from the application injector)
**before** `renderApplication` resolves; Analog's `render()` returns a plain
`(url, document, { req, res }) => Promise<string>` that the application's own `main.server.ts`
exports, and its public `RESPONSE` token is that request's `res`.

That is a supported, pre-commit seam. The full-stack fixture uses it
(`src/app/render-failure-status.ts`): an application-level `ErrorHandler` marks its own `RESPONSE` in a
`WeakSet`; a wrapper around the exported render function replaces a marked (or rejected) render by a
generic HTTP 500, `no-store`, hydration-free document before anything is written, and logs one
redacted line (error class only). No private hook, no patched output, no string matching, no Angular
dependency added to `@strata-sc/core`; native Analog rendering is unchanged.

Classification (PACKED CONSUMER on Node and LOCAL WORKERD; DEPLOYED on Cloudflare Pages):

| Failure                                        | Native Analog (internal fixture, still pinned)      | With the contract                     |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| Server Component constructor throws            | 200, empty outlet                                   | 500, generic document, no-store       |
| Injected dependency throws                     | 200, empty outlet                                   | 500                                   |
| Template binding throws after partial output   | 200, half-rendered document                         | 500, no partial text                  |
| Client boundary refused (unserializable props) | 200, incomplete boundary host                       | 500, no `data-strata-*`, no hydration |
| App initializer throws (before rendering)      | render rejects                                      | 500                                   |
| Unmatched URL (router error)                   | 200, empty shell                                    | the application's own 404 page        |
| Missing client reference / server-only module  | build-time refusal (existing firewall and AOT gate) | unchanged                             |

Also verified: a healthy page through the same wrapper is 200; 24 overlapping failing and healthy
renders keep their own status; the next ordinary document is complete; no private canary in body,
headers or server log. The internal fixture keeps native rendering and its pinned HTTP-200 controls
(`test:server-component-failures`, `test:server-component-ssr-response`), the negative control for the
unwrapped path. Hydration, exactly-once interaction, build-mismatch recovery, request isolation and
document navigation suites pass unchanged (HOSTED CI).

Not claimed: Strata does not ship or install this wrapper; it is an application-owned pattern
documented in [COMPATIBILITY](../COMPATIBILITY.md), qualified on a synthetic fixture. Whether Strata
should export it is an API decision left for review. Streaming SSR stays unsupported.

### Published analog 0.12.1 and the frozen candidate (PUBLISHED REGISTRY, local)

`httpSuite` now sends an oversized validated body and a second request on one raw keep-alive socket
(Nitro node-server), once and on 8 concurrent sockets. With the published 0.12.1: 413 then 200 on all
9 sockets. With the published 0.12.0 (historical negative control, same fixture): 413 then **400** on
all 9 sockets, the only failing checks. Candidate `402f33e953f9a04b` was recaptured from a fully
passing fresh registry run: core 0.2.2 / analog 0.12.1 / server-components 0.14.0 with npm
integrities, consumer lock 869 packages (digest `29a0d604…`), TS 5.9 lock 80 packages, Node 22.23.1,
npm 10.9.8, Playwright 1.62.1 / Chromium 151.0.7922.34, Wrangler 4.135.0, compatibility date
2026-09-21, no flags. `pnpm test:full-stack-frozen-candidate` (`npm ci`) reproduces it with
byte-identical Strata files and the same lock digest.

### Deployed upgrade and rollback (DEPLOYED GO, first)

Published pair, both arms analog 0.12.1: A = server-components 0.13.0, B = 0.14.0 (the only
difference). Run [42058305233](https://github.com/Andersseen/Strata/actions/runs/42058305233):
`{"LOCAL REHEARSAL":"GO","DEPLOYED":"GO"}`. A deployed and stable at its immutable URL; B deployed and
stable; A's immutable URL unchanged; an A tab navigating into B hydrates and calls B's API; B document
with A's deployed scripts refused as build-mismatch, one bounded reload when converging, no reload
loop when not; Back/Forward hydrated; controller and SSR authorization, receipts and the SSR failure
contract in every phase; A's retained artifact restored and verified; 829 edge requests, 0 anomalies.
The previous four M5 runs were NO-GO (F5, then F6); run 42053107714 of this work was refused before
deploying (log-redaction defect in the new fixture, fixed) and its gate correctly reported
"DEPLOYED: NOT RUN".

### Release state and #117 (tooling; HOSTED)

Release 42048951547 (main `94347ea`, CI success): authorization passed (exact SHA, single successful
Verify, still main); state ALREADY_PUBLISHED; align moved analog `next` 0.12.0 → 0.12.1 and saw it;
0.4 s later the verification read the separately cached abbreviated packument, still 0.12.0, and failed
the run. npm then served `next = latest = 0.12.1` consistently. `verifyPublicationEventually` now waits
within the same bound while its only problems are dist-tag lag (UNIT: the 42048951547 sequence passes,
a tag wrong for the whole bound still fails, a dependency-range problem never waits). Release
42043634935 refused the cancelled main CI 42041343959 ("did not complete successfully"): hosted evidence
of the cancelled transition. Pending and stale-main transitions are still unobserved: **#117 stays open.**
No tag was moved by hand.

## Hosted evidence

| Workflow                                                                                               | Head      | Result                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------- |
| CI [42060660230](https://github.com/Andersseen/Strata/actions/runs/42060660230)                        | `962b7b5` | success, 11/11 jobs and Verify, 10.2 min                                                                   |
| CI [42055399997](https://github.com/Andersseen/Strata/actions/runs/42055399997)                        | `0e0323e` | success, 10.2 min                                                                                          |
| Extended `registry` [42060084319](https://github.com/Andersseen/Strata/actions/runs/42060084319)       | `4315e08` | success: frozen candidate (`npm ci` on Linux), published tuple, published A/B + rehearsal, published Pages |
| Extended `adversarial` [42060101479](https://github.com/Andersseen/Strata/actions/runs/42060101479)    | `4315e08` | success: all four source mutations rejected                                                                |
| Deployed packed [42058285983](https://github.com/Andersseen/Strata/actions/runs/42058285983)           | `419359f` | DEPLOYED GO                                                                                                |
| Deployed upgrade/rollback [42058305233](https://github.com/Andersseen/Strata/actions/runs/42058305233) | `419359f` | LOCAL REHEARSAL GO, DEPLOYED GO                                                                            |
| Deployed packed [42053087187](https://github.com/Andersseen/Strata/actions/runs/42053087187)           | `e73fc39` | DEPLOYED NO-GO (F5 residual, fixed; kept as evidence)                                                      |
| Deployed upgrade/rollback [42053107714](https://github.com/Andersseen/Strata/actions/runs/42053107714) | `e73fc39` | refused before deploying (log-redaction defect in the new fixture, fixed)                                  |

Commits after `4315e08` change only documentation; the deployed and Extended runs therefore qualify
the final test, fixture and tooling code.

## Security and confidentiality evidence

Read receipts carry only ids and counts. Private markers (tenant data, credentials, the render-failure
canary) are absent from every browser file and source map, every API and SSR response, the hydrated DOM
and the server log (render failures log a redacted line), on Node, local workerd and the deployed
project. The adversarial suite rejects all four source mutations. Credentials reach only the deploy
step of the manual workflow.

## Local verification (macOS arm64, Node 22.23.1)

PASS: `pnpm install --frozen-lockfile`, `build`, `lint`, `typecheck`, `format:check`, `test` (incl.
`test:ci`), actionlint; `test:full-stack-package-consumer`; `test:full-stack-multi-isolate`;
`test:full-stack-deployed-cloudflare` (local rehearsal); `test:full-stack-adversarial-security` (all
four mutations); `test:full-stack-registry-consumer` (0.12.1, with capture); the same with analog
0.12.0 (expected FAIL, negative control); `test:full-stack-frozen-candidate`;
`test:full-stack-registry-upgrade-rollback` (local Node + workerd + rehearsal, 1439 checks).

NOT RUN locally (run on HOSTED CI for every pushed head instead): the graph, navigation, `@defer`,
server-only, optimizer, dev-server, runtime-contract, Analog-contract, packed Server Components,
installed-island, packed DI, deployment-skew, Cloudflare PoC, website and Relay suites. They were not
changed except through the shared request recorder (`RequestRecord` gained two optional fields).

## 1.0 checklist changes

| #   | Before  | After   | Justification                                                                                                                                   |
| --- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | BLOCKED | PARTIAL | A supported public seam exists and is qualified packed, local workerd and deployed. Not PASS: application-owned, not a Strata API; no real app. |
| 17  | PARTIAL | PARTIAL | Two more deployed GO runs of the full fixture; the frozen lock itself was not deployed.                                                         |
| 19  | PARTIAL | PARTIAL | F6/F5 resolved on the real deployment; bindings still not exercised; Angular DI on workerd still NO-GO.                                         |
| 21  | PARTIAL | PARTIAL | First DEPLOYED GO of A/B upgrade, stale assets and rollback; a real consumer rollback is still missing.                                         |
| 22  | PARTIAL | PARTIAL | Mandatory coverage now machine-checked; no release-candidate record yet.                                                                        |
| 24  | PARTIAL | PARTIAL | Candidate recaptured with analog 0.12.1 and reproduced frozen; one tuple only.                                                                  |
| 26  | PARTIAL | PARTIAL | Policy now written (COMPATIBILITY); it becomes evidence once reviewed and merged, and has not yet governed a release.                           |

Totals: PASS 1, PARTIAL 27, BLOCKED 0, NOT RUN 4. **Not 1.0-ready.**

## Remaining blockers

- Real application adoption (#29–#32), a separate repository effort: NOT RUN.
- Whether Strata exports the render-failure wrapper (API review), and a real application using it.
- Angular JIT on workerd (consumer DI and `serverFn`): upstream.
- Client-disconnect cancellation: no supported signal through the Nitro adapters.
- Cloudflare isolate cold start and Worker memory: NOT MEASURED.
- #117: pending and stale-main hosted transitions unobserved.
- Installed-island check L: diagnostic expectation is ordering-dependent (one hosted failure).

## Readiness estimate

About **80 %** (from about 75 %), uncertainty ±5 points. The only BLOCKED criterion now has a
qualified supported seam, the deployed authorization and upgrade/rollback qualifications pass for the
first time, and CI feedback is about three times faster with enforced coverage. It is not 85 %: four
criteria need a real application, the failure contract is not a Strata API, and no criterion closed.
