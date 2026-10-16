# Full-stack performance scaling: one island versus three

Date: 2026-10-16  
Starting `main`: `546b35ccb708d784ef46bea2eb35a90736a3da79`  
Branch: `test/performance-multi-island-scaling`  
Tested head (hosted run): `9821d581e44286c8ccaab681821f06d50c905e25`  
Command: `STRATA_PERF_ISLANDS=1|3 pnpm test:full-stack-performance` (runner `tools/performance/full-stack.ts`, fixture `tests/full-stack-performance/fixture`)  
Builds on: [full-stack-performance-baseline.md](full-stack-performance-baseline.md) (historical numbers there are not restated or altered).

This qualifies how Strata's **bundle overhead scales from one interactive island to three distinct ones**,
using the existing four-arm benchmark unchanged in method. It is evidence, not a qualification: it asserts
correctness and confidentiality strictly and asserts **no** size or latency threshold. R13 stays open; Strata 1.0
is not qualified. Labels: **MEASURED** (observed here), **PROPOSED** (candidate, unenforced), **NOT MEASURED**,
**NOT QUALIFIED**.

## Verdicts first

| Verdict                                        | Result                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| One-island benchmark regression                | GO (local numbers equal PR #86 to the 0.1 KiB; hosted browser bytes byte-identical to local)                             |
| Three-island functional equivalence            | GO (all four arms: SSR, three public APIs, unknown-product 404, boundaries)                                              |
| Three-island hydration and interaction         | GO (original DOM nodes reused, one request and one state update per click, no cross-island effect)                       |
| Browser/server graph confidentiality           | GO (both profiles, both presets, three canaries, positive controls; 11 negative controls rejected at three islands)      |
| Node measurement                               | GO                                                                                                                       |
| Local workerd measurement                      | GO                                                                                                                       |
| GitHub-hosted reproducibility                  | GO (corrective run 38904588640 green; one earlier run failed for two proven infrastructure reasons, see Hosted evidence) |
| Candidate browser-size budget                  | SUPPORTED (as a fixed-cost candidate on this fixture family; per-island marginal cost not separable)                     |
| Candidate server-size budget                   | INSUFFICIENT EVIDENCE (the island dimension never exceeded it, but controller/provider scaling was not varied)           |
| Production performance budgets                 | NOT QUALIFIED                                                                                                            |
| Cloudflare edge cold-start performance         | NOT MEASURED                                                                                                             |
| Cloudflare Worker memory consumption           | NOT MEASURED                                                                                                             |
| Cancellation and cleanup under production load | NOT QUALIFIED                                                                                                            |
| Real application adoption                      | NOT QUALIFIED                                                                                                            |
| Strata 1.0                                     | NOT YET QUALIFIED                                                                                                        |

## The island dimension

`STRATA_PERF_ISLANDS` (default **1**; only `1` and `3` are accepted, anything else fails before any work).
Both profiles use the **same four arms** (A native, B controllers, C Server Components, D both), the same
packed tarballs outside the workspace, the same Nitro presets, the same compression and the same measurement
policy. One shared fixture: `islands-3/` only _adds_ files to `common/` and `variants/`; with one island the assembled
application is byte-identical to PR #86's (a unit test pins this).

| Profile   | Interactive islands                                                                                             | Public endpoints                                | Server-owned data                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1 island  | `product-availability`                                                                                          | `GET /api/products/:id`                         | product repository, transitive helper, supplier canary                                                                                    |
| 3 islands | `product-availability`, `product-stock`, `product-delivery` (three distinct components, own state, own request) | the above plus `/:id/stock` and `/:id/delivery` | the above plus a fulfilment repository (server-only in C/D) whose private warehouse canary is consumed to choose the public `region` prop |

In the Server Component arms the parent renders on the server and marks each island with `[strataClient]`; the
serialized props are `productId` (all three) and `region` (delivery). Plain arms render the same components through
the ordinary Angular graph. Native arms emit one Nitro file route per endpoint; controller arms register all handlers
from one `@Controller`.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm --filter @strata-sc/www exec playwright install chromium   # once
STRATA_PERF_ISLANDS=1 STRATA_PERF_OUT=/tmp/perf-one   pnpm test:full-stack-performance   # about 6 min
STRATA_PERF_ISLANDS=3 STRATA_PERF_OUT=/tmp/perf-three pnpm test:full-stack-performance   # about 6 min
pnpm test:full-stack-performance:compare /tmp/perf-one/report.json /tmp/perf-three/report.json /tmp/perf-three
pnpm test:performance-tools            # 163 deterministic self-tests (94 before this work)
```

On GitHub: `gh workflow run extended.yml --ref <branch> -f suite=performance -f islands=both` (or `one` / `three`).
`both` runs the two profiles one after the other **in the same job on the same runner**, then the comparison, and uploads
`one-island/`, `three-island/`, `comparison.md` and a redacted `environment.txt`. The weekly schedule keeps the
one-island baseline. The comparison refuses a pair that is not comparable (different package versions,
dependency tuple, Node/wrangler/compatibility date, compression, presets or arm definitions, an incomplete report,
an arm that failed correctness) and exits 1.

## Environments

|                               | Local                                                                                                          | GitHub-hosted                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| OS / arch                     | macOS (darwin 25.6.0) / arm64                                                                                  | Linux (ubuntu24 image 20261012.334.1) / X64 |
| CPU                           | Apple M4, 10 cores                                                                                             | AMD EPYC 7763, 4 vCPU, 16 GiB               |
| Node / npm / pnpm             | v22.23.1 / 10.9.8 / 10.30.1                                                                                    | v22.23.3 / 10.9.9 / 10.30.1                 |
| wrangler / compatibility date | 4.135.0 / 2026-09-21                                                                                           | 4.135.0 / 2026-09-21                        |
| Workload                      | 3 repetitions x 200 requests per target and mode, warm-up 50, concurrency 8, 3 fresh builds per arm and preset | same                                        |
| Measured commit               | `52e0f86` (dirty tree: later test, workflow and documentation files only)                                      | `9821d58` (clean tree)                      |

Dependency tuple (identical for all eight arm-builds, 16 named packages, 819 locked non-Strata entries per arm, equal
locally and hosted): Angular 22.1.7 (build 22.1.8), Analog 2.7.2 (nitro plugin 2.8.1), nitropack 2.13.4, h3 1.15.11, vite 8.3.0,
TypeScript 6.0.3, rxjs 7.8.2, tslib 2.8.1.

Strata packages (private, packed with `pnpm pack`, never published): `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.2.2,
`@strata-sc/server-components` 0.2.1. Tarball sizes are identical locally and hosted (8,117 / 19,875 / 77,293 B); the
**digests differ between machines** (the tar/zlib output differs), so artifact identity is per environment:

| Package           | sha256, local (both profiles)                                      | sha256, hosted (both profiles) |
| ----------------- | ------------------------------------------------------------------ | ------------------------------ |
| core              | `49434df58bb205fb1a69c07eb1b9b6cb334b2e1b7161343f1cbbc0167995bfcb` | `a0238aa624a8…`                |
| analog            | `8f4ed0cd125fd960ac05f90467b7d9de7d31a639fb050997feb852d53b80c5a0` | `d532688d0cc4…`                |
| server-components | `3fa949be0159c0dd917f0efdf31bd38e80977a2e84102079019baf88fd400017` | `10e04d8d6184…`                |

The full hosted digests are in the run's uploaded `report.json` files.

## Results: size (MEASURED, local macOS, same run)

Arrows are `one island → three islands` for each arm. Browser JavaScript and the initial entry are identical
for A/B (controllers add no browser bytes) and for C/D. Source maps are excluded from every figure.

| Metric                  | A native                | B controllers           | C Server Components     | D full Strata           |
| ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- |
| Browser JS raw          | 267.4 KiB → 270.1 KiB   | 267.4 KiB → 270.1 KiB   | 271.7 KiB → 273.7 KiB   | 271.7 KiB → 273.7 KiB   |
| Browser JS gzip         | 81.6 KiB → 82.1 KiB     | 81.6 KiB → 82.1 KiB     | 83.3 KiB → 83.6 KiB     | 83.3 KiB → 83.6 KiB     |
| Browser JS Brotli       | 71.7 KiB → 72.1 KiB     | 71.7 KiB → 72.1 KiB     | 73.2 KiB → 73.4 KiB     | 73.2 KiB → 73.4 KiB     |
| Initial entry chunk raw | 263.6 KiB → 263.6 KiB   | 263.6 KiB → 263.6 KiB   | 264.5 KiB → 264.5 KiB   | 264.5 KiB → 264.5 KiB   |
| Lazy chunks raw         | 3.8 KiB → 6.5 KiB       | 3.8 KiB → 6.5 KiB       | 7.2 KiB → 9.1 KiB       | 7.2 KiB → 9.1 KiB       |
| Browser JS files        | 4 → 4                   | 4 → 4                   | 4 → 4                   | 4 → 4                   |
| Node server graph raw   | 1202.0 KiB → 1210.4 KiB | 1206.2 KiB → 1213.0 KiB | 1209.0 KiB → 1218.3 KiB | 1213.1 KiB → 1220.9 KiB |
| Node deployable bytes   | 5568.6 KiB → 5596.8 KiB | 5582.3 KiB → 5607.0 KiB | 5602.3 KiB → 5629.0 KiB | 5616.0 KiB → 5639.1 KiB |
| Worker graph raw        | 722.2 KiB → 727.7 KiB   | 729.7 KiB → 733.1 KiB   | 726.3 KiB → 732.3 KiB   | 733.7 KiB → 737.6 KiB   |
| Worker graph gzip       | 201.3 KiB → 202.9 KiB   | 204.1 KiB → 204.6 KiB   | 202.8 KiB → 204.6 KiB   | 205.6 KiB → 206.3 KiB   |
| Pages deployable bytes  | 3852.1 KiB → 3874.3 KiB | 3865.2 KiB → 3884.4 KiB | 3880.3 KiB → 3899.9 KiB | 3893.4 KiB → 3909.9 KiB |

Chunk counts did not change (4 browser JS files in every arm and profile); the island components live in the
lazy route chunk, so the initial entry grew by 0 B (A) / 8 B (C/D) when two islands were added.

### Overheads and how they changed

| Metric                | C−A (1)  | C−A (3)  | D−A (1)   | D−A (3)   | B−A (1 / 3)     | A grew by | C−A changed by | D−A changed by |
| --------------------- | -------- | -------- | --------- | --------- | --------------- | --------- | -------------- | -------------- |
| Browser JS raw        | +4.3 KiB | +3.6 KiB | +4.3 KiB  | +3.6 KiB  | 0 / 0           | +2.7 KiB  | −738 B         | −738 B         |
| Browser JS gzip       | +1.7 KiB | +1.5 KiB | +1.7 KiB  | +1.5 KiB  | 0 / 0           | +506 B    | −231 B         | −231 B         |
| Browser JS Brotli     | +1.5 KiB | +1.3 KiB | +1.5 KiB  | +1.3 KiB  | 0 / 0           | +444 B    | −230 B         | −230 B         |
| Node server graph raw | +7.0 KiB | +7.9 KiB | +11.1 KiB | +10.4 KiB | +4.1 / +2.6 KiB | +8.4 KiB  | +943 B         | −683 B         |
| Worker graph raw      | +4.0 KiB | +4.6 KiB | +11.5 KiB | +9.9 KiB  | +7.5 / +5.3 KiB | +5.5 KiB  | +540 B         | −1.6 KiB       |
| Worker graph gzip     | +1.5 KiB | +1.7 KiB | +4.4 KiB  | +3.4 KiB  | +2.8 / +1.8 KiB | +1.6 KiB  | +159 B         | −933 B         |

Interaction (D−B−C+A) is within ±15 B for every metric in both profiles (zero for the browser). The hosted run
reproduces every number above: browser JavaScript raw and gzip bytes are **byte-identical** to local in all eight
builds, server-graph raw bytes equal to local except ±2 B in the four controller (B) builds, server gzip bytes within 7 B, and
the deployable total differs by 1.6 to 2.7 KiB (platform-specific traced files). Builds were deterministic across
the three repetitions in every arm and preset, locally and hosted.

### Byte attribution (what the numbers do and do not say)

Three different things grow when two islands are added, and only the last is Strata:

1. **Total application growth** (A, which has no Strata): +2.7 KiB browser raw, +8.4 KiB Node graph, +5.5 KiB Worker
   graph. This is the extra public island code, the second and third island's routes and the inventory data.
2. **Additional public implementation code** is part of (1) and is identical in all four arms by construction.
3. **Strata-attributable growth** is the _change_ in each overhead (the right-hand columns). It is small or
   **negative**: the Server Components overhead did not grow in the browser (−738 B raw, −231 B gzip).

Why a negative change is not "free islands": C−A is a **net** quantity. The plain arms ship the whole page
implementation (including the fulfilment repository and the larger details template) to the browser, while the Server
Component arms keep it server-only and ship only the boundary runtime and the islands. Adding the fulfilment module
makes the server-only exclusion saving larger at three islands, which offsets the added boundary markup for two more
islands. With these two profiles the **boundary-runtime/protocol cost per island cannot be separated from the
exclusion saving**. The only per-island figure that can be stated is the observed net mean over the two added
islands: Server Components browser −369 B raw / −115 B gzip per island, Node server +471 B, Worker raw +270 B, Worker
gzip +80 B. These are not extrapolated beyond the two measured profiles.

The controllers' server overhead _shrinks_ (B−A: Node +4.1 → +2.6 KiB, Worker +7.5 → +5.3 KiB raw) because the native
arm emits one Nitro file route per endpoint: the Worker chunk list of A has 12 server chunks at three islands (one route chunk per endpoint plus a shared
inventory chunk; 9 at one island) against 8 in B and D at either size, where the handlers sit inside the one controller in
the existing server chunk. This is **MEASURED** (chunk lists in the report) and specific to file-routed Nitro versus a
single controller; it does not predict the cost of many controllers, providers or validation.

## Results: SSR document size and latency (MEASURED)

The SSR document grew with the page, which is an application effect and not a framework cost:

| Arm                      | Document, 1 island | Document, 3 islands |
| ------------------------ | ------------------ | ------------------- |
| A, B (plain Angular)     | 1,804 B            | 2,331 B             |
| C, D (Server Components) | 1,930 B            | 2,738 B             |

Boundary markup adds 126 B at one island and 407 B at three (about 140 B per added island) on top of the
plain document. Gzip of the document was not recorded.

Warm loopback latency, sequential mode, median of three repetitions, p50 / p90 / p95 in ms (concurrent-mode tables, min–max
across repetitions, raw samples and status distributions are in `report.json`). Every measured response was
semantically validated; there were **no invalid responses and all statuses were 200** in both profiles and both runtimes.

**Node, local macOS, one island**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 1.79 ms | 2.29 ms | 2.36 ms | 7.15 ms | 8.40 ms | 8.97 ms |
| B   | 1.66 ms | 2.15 ms | 2.30 ms | 7.27 ms | 8.68 ms | 9.02 ms |
| C   | 1.61 ms | 1.98 ms | 2.09 ms | 7.10 ms | 8.45 ms | 9.00 ms |
| D   | 1.71 ms | 2.37 ms | 2.46 ms | 7.23 ms | 8.86 ms | 9.27 ms |

**Node, local macOS, three islands**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 1.69 ms | 2.26 ms | 2.33 ms | 6.92 ms | 8.28 ms | 8.86 ms |
| B   | 1.71 ms | 2.37 ms | 2.47 ms | 7.33 ms | 8.84 ms | 9.39 ms |
| C   | 1.64 ms | 2.28 ms | 2.36 ms | 7.16 ms | 8.60 ms | 9.09 ms |
| D   | 1.69 ms | 2.34 ms | 2.41 ms | 6.78 ms | 8.51 ms | 8.74 ms |

**Local workerd, local macOS, one island**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 2.66 ms | 3.04 ms | 3.42 ms | 10.7 ms | 13.2 ms | 14.0 ms |
| B   | 2.70 ms | 3.27 ms | 3.57 ms | 10.9 ms | 13.3 ms | 14.3 ms |
| C   | 2.63 ms | 3.33 ms | 4.11 ms | 11.5 ms | 13.8 ms | 14.5 ms |
| D   | 2.52 ms | 3.02 ms | 3.33 ms | 11.2 ms | 13.6 ms | 14.1 ms |

**Local workerd, local macOS, three islands**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 2.51 ms | 2.85 ms | 2.99 ms | 10.7 ms | 13.4 ms | 14.3 ms |
| B   | 2.59 ms | 3.11 ms | 3.60 ms | 10.8 ms | 13.2 ms | 14.1 ms |
| C   | 2.80 ms | 3.36 ms | 4.23 ms | 11.3 ms | 14.0 ms | 14.9 ms |
| D   | 2.58 ms | 3.07 ms | 3.54 ms | 11.5 ms | 13.8 ms | 14.3 ms |

On this host the Server Component arms C and D show an SSR p50 about 0.5 to 0.8 ms above A and B in local workerd in both
profiles (for example 11.5 / 11.2 versus 10.7 / 10.9 ms at one island); the repetition ranges nearly touch, the offset does
not grow from one island to three, and the hosted workerd run does not reproduce it consistently. It is recorded as an
observation within noise; no latency is attributed to the framework. Node API and SSR differences are within the
repetition spread everywhere. Local workerd does not qualify deployed latency, and cold start and Worker memory are NOT MEASURED.

## GitHub-hosted evidence (MEASURED)

Run [38904588640](https://github.com/Andersseen/Strata/actions/runs/38904588640), `workflow_dispatch` of the **existing**
`extended.yml` with `suite=performance islands=both` on the branch at `9821d581e44286c8ccaab681821f06d50c905e25`, ubuntu-latest
(AMD EPYC 7763, 4 vCPU, 16 GiB), 27.6 minutes, conclusion **success**, `contents: read`, no secrets, no deployment. The comparison
step classified the two reports as **same-run** (one runner, one commit, minutes apart): size and latency are directly comparable
within the run; the local-versus-hosted comparison is **cross-machine** (sizes only).

An earlier run, [38901423753](https://github.com/Andersseen/Strata/actions/runs/38901423753) at `433623439080c9c840c58921e54399a562563ee5`,
failed for two proven infrastructure reasons, both fixed and not repeated for a better number:

1. The one-island report could not resolve `git merge-base HEAD origin/main` in a shallow clone (`baseline.startingMainSha`
   empty). The extended `performance` job now checks out with `fetch-depth: 0`. This defect existed in `extended.yml` as merged
   by #87 and affected every hosted performance run, one island included.
2. In the three-island profile, the final local-workerd start of the very last repetition died with `bind(): Address already in use`
   (a pick-then-bind port race). Starting a workerd arm is now retried, on that error only, at most twice (unit-tested);
   no correctness failure is ever retried. The corrective run logged no collision.

Hosted size results equal the local ones as described above. Hosted latency, sequential, p50 / p90 / p95 in ms:

**Node, hosted, one island**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 0.55 ms | 0.60 ms | 0.65 ms | 5.40 ms | 6.62 ms | 7.20 ms |
| B   | 0.55 ms | 0.65 ms | 0.68 ms | 5.19 ms | 6.25 ms | 6.78 ms |
| C   | 0.52 ms | 0.68 ms | 0.83 ms | 5.34 ms | 6.32 ms | 6.91 ms |
| D   | 0.57 ms | 0.68 ms | 0.69 ms | 5.19 ms | 6.21 ms | 6.67 ms |

**Node, hosted, three islands**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 0.50 ms | 0.68 ms | 0.79 ms | 5.06 ms | 6.04 ms | 6.65 ms |
| B   | 0.58 ms | 0.68 ms | 0.70 ms | 5.19 ms | 6.48 ms | 6.91 ms |
| C   | 0.54 ms | 0.62 ms | 0.70 ms | 5.37 ms | 6.53 ms | 7.16 ms |
| D   | 0.64 ms | 0.68 ms | 0.73 ms | 5.14 ms | 6.23 ms | 6.62 ms |

**Workerd, hosted, one island**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 3.04 ms | 4.05 ms | 4.73 ms | 10.3 ms | 11.7 ms | 12.6 ms |
| B   | 2.92 ms | 3.74 ms | 4.64 ms | 10.4 ms | 12.2 ms | 13.1 ms |
| C   | 3.05 ms | 3.86 ms | 4.48 ms | 10.4 ms | 12.3 ms | 13.4 ms |
| D   | 2.96 ms | 3.60 ms | 4.40 ms | 10.3 ms | 11.8 ms | 13.1 ms |

**Workerd, hosted, three islands**

| arm | API p50 | API p90 | API p95 | SSR p50 | SSR p90 | SSR p95 |
| --- | ------- | ------- | ------- | ------- | ------- | ------- |
| A   | 2.77 ms | 3.69 ms | 4.52 ms | 9.99 ms | 11.6 ms | 12.3 ms |
| B   | 2.91 ms | 3.66 ms | 4.62 ms | 9.47 ms | 11.2 ms | 12.1 ms |
| C   | 2.80 ms | 3.47 ms | 4.67 ms | 10.6 ms | 11.9 ms | 12.9 ms |
| D   | 2.92 ms | 3.76 ms | 4.72 ms | 10.0 ms | 12.0 ms | 12.7 ms |

## Hydration, interaction and confidentiality (MEASURED)

Real Chromium per arm and runtime (eight arm and runtime pairs per profile). **Three islands:** the SSR DOM of every island is tagged
before any script runs; after hydration the original button, output and text nodes of **each** island are the same nodes
(hydration reuse), each island appears exactly once, each is clicked once and issues exactly one request to its own endpoint, exactly
that island's state changes (the other two keep their prior text), and there is no console error or warning, failed request or private
canary in the hydrated DOM. **One island:** the PR #86 smoke, unchanged (it does not check failed requests or the hydrated DOM for canaries).

Confidentiality uses the existing synthetic markers plus the new fulfilment marker and warehouse canary: in C/D the Server
Component implementation, product and fulfilment repositories, transitive helper and all canaries are absent from every browser
chunk and source map, from the SSR HTML (including each boundary's serialized props) and every API response in both profiles, and from the hydrated DOM at three islands; the
three client-island markers are present in every browser (positive controls). In A/B the plain repositories ship to the browser (the expected
scanner control, not a leak); controller and Nitro handler markers are server-only in every arm; arm A contains no Strata specifier,
dependency, lock entry, installed package or output.

## Negative controls (all rejected)

The six one-island controls are unchanged. The three-island profile adds, each breaking exactly one island or canary:
`island-missing-from-ssr` (one of three islands not rendered), `island-boundary-identity-collision` (two islands share one boundary
identity in the real SSR document), `island-click-issues-no-request` (the delivery button's click never reaches its handler),
`island-state-not-updated` (the stock request is aborted), `browser-leak-warehouse` (the fulfilment canary appended to a browser chunk). The
existing missing-browser-functionality control also runs the three-island interaction check. 11 of 11 were rejected, locally and hosted, each
for the intended reason (recorded in `report.json`). Unit tests additionally cover duplicate hydration, missing islands, wrong
boundary identity, incomplete or mismatched comparison reports, delta arithmetic with zero, negative and missing values, invalid-response
exclusion and canary detection.

## Candidate budget assessment (PROPOSED values, nothing enforced)

| Budget (from PR #86)                         | One island        | Three islands    | Assessment                                                                                                    |
| -------------------------------------------- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Controllers: +0 browser JS                   | 0 B               | 0 B              | **Supported**, and an existing correctness guarantee that stays enforced separately                           |
| Server Components: ≤ +3 KiB gzip browser     | +1.7 KiB          | +1.5 KiB         | **Supported** as a fixed-cost figure; it did not grow with two more distinct islands. Not a per-island budget |
| Full stack, Node/Worker graph: ≤ +20 KiB raw | +11.1 / +11.5 KiB | +10.4 / +9.9 KiB | Within, with about half the headroom unused                                                                   |
| Full stack, Worker graph: ≤ +8 KiB gzip      | +4.4 KiB          | +3.4 KiB         | Within                                                                                                        |

- **One-island fixed-cost budget.** The numbers are exactly PR #86's. They are a property of the fixture's small, mostly
  server-only page.
- **Total overhead of several distinct islands.** Did not increase on any measured axis; the browser overhead decreased because server-only
  code was excluded. The one-island 3 KiB number was **not** applied to the three-island application as a rule; it is reported
  next to the measurement.
- **Per-island marginal cost.** Not separable (net, confounded with server-only exclusion, two points). Not extrapolated.
- **Baseline size drift.** Arm A moved from 267.4 to 270.1 KiB browser raw only because the application grew; PR #86's own A at one island
  is reproduced exactly.
- **Nondeterministic output.** None observed: raw browser and server bytes were identical across three builds in every arm and preset, and
  server gzip varies by a few bytes between builds, which is why gzip is never used as a determinism fingerprint.
- **Server budget.** Evidence is insufficient to call it scaling-safe because the dimension that dominates server cost (controller,
  provider and validation count, route count against file routes) was not varied; the island dimension adds handlers inside one controller only.

R13 is **not** closed by this measurement.

## Methodology limitations

- Two points (1 and 3) on a tiny synthetic fixture; no model, no per-island extrapolation. The islands are small and similar.
- C−A is a net of boundary cost and server-only exclusion; the fixture's excluded server code is small and its ratio to island code is arbitrary.
- One application shape, one Angular/Analog/Nitro tuple, Chromium only, loopback only, warm only. Local workerd is not Cloudflare.
- Three repetitions; spreads of 0.2 to 1 ms mean latency differences under that are not resolvable. The hosted runner has 4 shared vCPUs.
- Gzip of the SSR document, cold start, Worker memory, RSS under load, cancellation and cleanup, and CPU time were not measured.
- The local measured tree was dirty with files that do not influence the measured output (unit tests, workflow edits, this document).
- Package digests vary by machine; the dependency lock tuple does not.

## Conclusions

- The Server Components fixed cost is about +1.5 to +1.7 KiB gzip in the browser and did not grow from one to three distinct islands on this
  fixture; controllers add no browser JavaScript; the combined server/Worker overhead (about 10 to 11.5 KiB raw, 3.4 to 4.4 KiB gzip) did not
  grow either.
- The benchmark, the comparison and the hosted workflow now exist for both profiles; hosted and local agree on size to within a few bytes.
- The candidate browser budget is supported on this fixture; the server budget needs a controller/provider-count dimension before it
  can be called supported. No threshold is added to CI.
- Recommended next increment: **cancellation and cleanup under production load** on Node and local workerd (client aborts,
  mid-stream disconnects and concurrent SSR plus controller traffic, with resource accounting), the remaining measurable
  piece of the open 1.0 resource item that does not require a Cloudflare deployment.
