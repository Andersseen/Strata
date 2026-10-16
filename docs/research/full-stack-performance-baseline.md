# Full-stack performance and bundle-cost baseline

Date: 2026-10-16  
Starting `main`: `1297271669ed9c419caf6f9997a3e58bffb06bf2`  
Branch: `test/full-stack-performance-baseline`  
Command: `pnpm test:full-stack-performance` (runner `tools/performance/full-stack.ts`, fixture `tests/full-stack-performance/fixture`)

This is the first controlled comparison of the same small Angular/Analog application **with and without**
Strata. It is a measurement, not a qualification: it asserts correctness strictly and asserts **no**
performance threshold. R13 stays open and no 1.0 resource gate is closed.

## Verdicts first

| Verdict                                    | Result                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Comparable benchmark methodology           | CONDITIONAL GO: sound for size; latency deltas are below run-to-run noise on this host (see Uncertainty) |
| Packed external consumer                   | GO (four arms, tarball sha256/sha512, single copy, identical 819-entry non-Strata lock tree)             |
| Node production measurement                | GO                                                                                                       |
| Local workerd measurement                  | GO                                                                                                       |
| Browser/server graph confidentiality       | GO (every arm, both presets, six negative controls rejected)                                             |
| Production performance budgets             | NOT QUALIFIED (candidates only, unenforced)                                                              |
| Cloudflare edge cold-start performance     | NOT MEASURED                                                                                             |
| Cloudflare Worker memory consumption       | NOT MEASURED                                                                                             |
| Cancellation and cleanup resource behavior | NOT QUALIFIED                                                                                            |
| Real application adoption                  | NOT QUALIFIED                                                                                            |
| Strata 1.0                                 | NOT YET QUALIFIED                                                                                        |

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm --filter @strata-sc/www exec playwright install chromium   # once
pnpm test:full-stack-performance
```

About 6 minutes. Output: `report.json` (structured, schema in `tools/performance/lib/report.ts`) and
`summary.md` in an OS temp directory printed at the end (`STRATA_PERF_OUT=<dir>` to choose; nothing is
written into the repository, raw artifacts are not committed). Overrides, all recorded in the report:
`STRATA_PERF_REPS` (3), `STRATA_PERF_BUILD_REPS` (3), `STRATA_PERF_REQUESTS` (200), `STRATA_PERF_WARMUP`
(50), `STRATA_PERF_CONCURRENCY` (8), `STRATA_PERF_KEEP=1`, and `STRATA_PERF_NATIVE_HANDLER=object` (diagnostic,
below). Deterministic runner self-tests run in normal CI (`pnpm test:performance-tools`, 94 tests); the full
measurement is explicit, plus a manual `workflow_dispatch` (`full-stack-performance.yml`: no deployment, no
publication, no secrets, 45 min timeout, uploads the JSON).

## Measurement environment (the run reported below)

Apple M4 (10 cores), macOS (Darwin 25.6.0) arm64, Node v22.23.1, npm 10.9.8, Wrangler 4.135.0 (local workerd,
compatibility date 2026-09-21, no flags, `nodejs_compat` **not** enabled), Chromium from the repository's
Playwright. The load generator (Node `fetch`, keep-alive) shares the machine with the server. Working tree was
the uncommitted branch (`workingTreeClean: false` in the report); `headSha` and `startingMainSha` are recorded.
Cross-machine numbers are **not** directly comparable.

Dependency tuple (identical in all four arms, verified from each arm's `package-lock.json`: 819 non-Strata
entries, versions and integrity): Angular 22.1.7 (build 22.1.8), `@analogjs/platform|router|vite-plugin-angular`
2.7.2, `@analogjs/vite-plugin-nitro` 2.8.1, nitropack 2.13.4, h3 1.15.11, vite 8.3.0, TypeScript 6.0.3, rxjs 7.8.2,
tslib 2.8.1, wrangler 4.135.0. Presets: Nitro `node-server` and `cloudflare-pages` (`BUILD_PRESET`).

Packed packages (built from this tree, `pnpm pack`, installed by `npm` as `file:` tarballs; none published):

| Package                        | Version | Tarball bytes | sha256                                                             |
| ------------------------------ | ------- | ------------- | ------------------------------------------------------------------ |
| `@strata-sc/core`              | 0.2.2   | 8,117         | `49434df58bb205fb1a69c07eb1b9b6cb334b2e1b7161343f1cbbc0167995bfcb` |
| `@strata-sc/analog`            | 0.2.2   | 19,875        | `8f4ed0cd125fd960ac05f90467b7d9de7d31a639fb050997feb852d53b80c5a0` |
| `@strata-sc/server-components` | 0.2.1   | 77,293        | `3fa949be0159c0dd917f0efdf31bd38e80977a2e84102079019baf88fd400017` |

Tarball sizes are package-distribution cost, not application cost; they are reported separately.

## The four arms

One application, two independent switches (`common/` shared; the only differing files live in `variants/`):

| Arm | Page                                                                    | `/api/products/:id`                                  | Strata installed                |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| A   | ordinary Angular component + repository                                 | native Nitro route                                   | none                            |
| B   | same                                                                    | `@Controller()`/`@Get()` via `registerControllers()` | core, analog                    |
| C   | `@ServerComponent()` + server-only repository + `[strataClient]` island | native Nitro route                                   | server-components               |
| D   | same as C                                                               | same as B                                            | core, analog, server-components |

Equivalence rules and evidence: identical title, semantic HTML, product data, button interaction, JSON
shape, route ids, three pages, Angular features (OnPush, signals, `@if`, hydration), `tsconfig`, source-map
setting (`hidden`), `target`, `ssr.noExternal: ["tslib"]`, and Nitro presets. A shared preflight asserts per
arm and runtime: `GET /api/products/42` is exactly `{id,name,available}` (HTTP 200, JSON, `no-store`),
an unknown id is 404 `not_found`, the SSR document has the same title, `Product 42` heading, server-computed tier and
`data-evidence` (a runtime fingerprint of the server-owned repository, which therefore executed), Strata
boundary markup appears **only** in C/D, and the responding handler is the arm's own (`x-perf-handler`).
A Chromium smoke per arm and runtime holds the scripts, tags the SSR DOM, then asserts hydration reuses the
heading/button/output/text nodes and one click renders the API result.

Unavoidable or deliberate differences (documented, not hidden):

1. **Plain arms ship the repository (and its private canary) to the browser**; that is what an ordinary
   Angular component graph is, and it is the very thing Server Components remove. The canary is therefore a
   positive control of the scanner in A/B, not a leak.
2. `server-only` is imported by the repository only in C/D (one resolved token).
3. The native route builds its web `Response` exactly as the controller does (like-for-like). The idiomatic
   h3 object-return handler is a selectable diagnostic (below).
4. Every arm contains an identical native `routes/api/health.get.ts`. Without a `routes/api` directory Analog
   injects a middleware that rewrites `/api/*` to the SSR catch-all, which shadows controllers (the known
   `/api` fallthrough limitation, unchanged here); keeping the file in all arms keeps the Nitro setup equal.
5. npm 10 currently crashes (`Cannot read properties of null (reading 'edgesOut')`) resolving `@angular/build`'s
   optional vitest peer, **including on main CI** (see Baseline failure). The arms install with
   `--legacy-peer-deps`; Analog's unused markdown/content peers stay uninstalled (allow-listed in the runner),
   anything else `npm ls` reports fails the arm.

## Method

- **Builds**: three fresh `vite build`s per arm and preset, order rotated; `dist`, `.angular`, generated
  sources and Vite caches removed before each. A failed build, wrong preset or missing entry fails the arm; it
  never becomes a number. Raw byte totals were identical across the three builds of every arm and preset;
  compressed server sizes varied by about 10 B (chunk hashes occur in the import text), so determinism is
  judged on raw bytes.
- **Categories** (never mixed): _browser JS_ = `.js` under `public/` (Worker directory excluded, maps
  excluded); _initial entry_ = the module script the SSR document loads; _initial graph_ = entry plus static
  imports; _lazy_ = other chunks; _server graph_ = modules **reachable** from `server/index.mjs` (Node) or
  `_worker.js/index.js` (Pages) by a lexical import walk, `node_modules` excluded (Nitro-traced runtime packages
  are reported separately); _deployable_ = `dist/analog` (Node) or `dist/analog/public` (Pages) by file class;
  source maps and metadata are separate classes and never count as code; a shared path is counted once.
- **Compression**: each file compressed separately (as a CDN serves it), gzip level 9, Brotli quality 11
  (text mode), same for every arm.
- **HTTP**: real production servers (`node dist/analog/server/index.mjs`; `wrangler pages dev`), fresh process per
  arm per repetition, 50 warm-up requests per target (checked, not sampled), then 200 sequential and 200 requests at concurrency 8,
  for `GET /api/products/42` and `GET /products/42`; monotonic `performance.now()` around fetch **and** body
  read; every response semantically validated, invalid ones are counted, excluded from percentiles and fail
  the arm. Percentiles are nearest-rank (p50/p90/p95). Three repetitions in a Williams-square arm order
  (ABCD, BDAC, DCBA) with target order alternating, so early warm-up cost is not assigned to one arm.
  Bounded: ≈ 450 requests × 2 targets × 4 arms per runtime per repetition.
- **Node extras** (experimental, Node-only): server process startup (spawn → first valid answer, 25 ms poll;
  **not** an isolate cold start) and RSS from `ps` of the owned child.

## Results

All numbers MEASURED from `report.json` of one run, except where marked.

### Size (deterministic; identical across 3 builds)

| Arm                      | Browser JS raw | gzip / Brotli   | Initial entry | Lazy chunks | Node server graph | Worker graph raw / gzip |
| ------------------------ | -------------- | --------------- | ------------- | ----------- | ----------------- | ----------------------- |
| A native baseline        | 267.4 KiB      | 81.6 / 71.7 KiB | 263.6 KiB     | 3.8 KiB     | 1202.0 KiB        | 722.2 / 201.3 KiB       |
| B controllers only       | 267.4 KiB      | 81.6 / 71.7 KiB | 263.6 KiB     | 3.8 KiB     | 1206.2 KiB        | 729.7 / 204.1 KiB       |
| C server components only | 271.7 KiB      | 83.3 / 73.2 KiB | 264.5 KiB     | 7.2 KiB     | 1209.0 KiB        | 726.3 / 202.8 KiB       |
| D full Strata            | 271.7 KiB      | 83.3 / 73.2 KiB | 264.5 KiB     | 7.2 KiB     | 1213.1 KiB        | 733.7 / 205.6 KiB       |

Δ vs A (D−B−C+A is the interaction; it is 0 B for every size above except ±10 B of compressed noise):

| Metric                   | B controllers     | C Server Components      | D combined         |
| ------------------------ | ----------------- | ------------------------ | ------------------ |
| Browser JS raw           | +0 B (0.0 %)      | +4.3 KiB (+1.6 %)        | +4.3 KiB (+1.6 %)  |
| Browser JS gzip / Brotli | +0 B              | +1.7 / +1.5 KiB (+2.1 %) | +1.7 / +1.5 KiB    |
| Initial entry raw        | +0 B              | +929 B (+0.3 %)          | +929 B (+0.3 %)    |
| Node server graph raw    | +4.2 KiB (+0.3 %) | +7.0 KiB (+0.6 %)        | +11.1 KiB (+0.9 %) |
| Worker graph raw         | +7.5 KiB (+1.0 %) | +4.0 KiB (+0.6 %)        | +11.5 KiB (+1.6 %) |
| Worker graph gzip        | +2.8 KiB (+1.4 %) | +1.5 KiB (+0.8 %)        | +4.4 KiB (+2.2 %)  |

Not part of the graph above: Nitro traces `@strata-sc/core`, `@strata-sc/analog` as Node externals for B/D
(`server/node_modules` 354,354 → 364,826 B, +10.2 KiB on disk); the deployable directory is 5.44 MiB (A) to
5.48 MiB (D), of which about 3.7 MiB is source maps in every arm. Tarballs: 8.1 + 19.9 + 77.3 KB (see above).

### Where the bytes are (inspected module graphs, not inferred from deltas)

- **Browser C/D**: the page chunk grows (lazy 3.8 → 7.2 KiB) and the entry by 929 B; the browser source maps
  show exactly three `@strata-sc/server-components` modules (the island boundary runtime) and **no**
  `@strata-sc/core|analog` module, no repository and no canary. The Server Component's own implementation is
  absent.
- **Server C**: the page chunk grows 7.5 → 13.6 KiB (Server Component runtime plus generated boundary
  wrapper) and the Angular SSR renderer chunk by 1,030 B.
- **Server B (Node)**: the adapter is inlined into the `nitro.mjs` chunk (+5.0 KiB) while core/analog are also
  traced; on Pages everything is inlined (`nitro.mjs` +8.2 KiB), which is why B's Worker delta (+7.5 KiB) is larger than C's (+4.0 KiB) while on Node it is smaller (+4.2 vs +7.0 KiB). The
  native route chunk disappears (−1 KiB) when the controller replaces it.
- Both SSR renderers are ≈ 1.0 MiB (Node) / 590 KB (Worker): Angular's own SSR runtime dominates every arm
  (≈ 99 % of the server graph), so Strata's share is single-digit KiB.
- **R13 and the old DI experiment**: the SPEC-003 server growth (4,492 → 7,716 KB) came from tracing
  `@angular/compiler` for Angular DI inside a Nitro plugin. This architecture keeps controller and SSR DI
  separate, and the controller arms add ≈ 0.3 % to the Node server graph. The old figures are **not** reused or
  compared; this is a different architecture.

### Latency (loopback, one host; median of 3 repetitions, min–max in the report)

Node production server, sequential (concurrent in `report.json`):

| Arm | API p50 / p95  | SSR p50 / p95  |
| --- | -------------- | -------------- |
| A   | 1.61 / 2.00 ms | 5.36 / 8.06 ms |
| B   | 1.65 / 2.53 ms | 5.43 / 7.60 ms |
| C   | 1.60 / 2.26 ms | 6.07 / 8.62 ms |
| D   | 1.54 / 2.17 ms | 5.28 / 7.11 ms |

Local workerd (Wrangler), sequential:

| Arm | API p50 / p95  | SSR p50 / p95  |
| --- | -------------- | -------------- |
| A   | 2.34 / 3.48 ms | 8.95 / 13.2 ms |
| B   | 2.50 / 3.71 ms | 9.21 / 11.8 ms |
| C   | 2.52 / 4.42 ms | 9.21 / 11.4 ms |
| D   | 2.37 / 3.69 ms | 9.13 / 11.9 ms |

Concurrency 8: Node API p50 1.9–2.0 ms and SSR p50 7.0–7.7 ms for all arms; workerd API p50 3.9–5.4 ms and
SSR p50 14.6–16.0 ms. **Every between-arm difference is inside the run-to-run range** of the same arm
(e.g. Node SSR p50 of A spans 5.24–6.95 ms across repetitions). No arm is faster or slower in a way this
design can resolve; the honest reading is "no latency effect detectable above ≈ 10–30 % noise". An earlier
shakedown run on the same host (builds disturbed by other work) showed the same picture with different
absolute values (Node SSR p50 ≈ 7 ms), which is why only the relative reading is stable.

Build wall time: 4.8–11.1 s per `vite build`; the **first build of an arm in a run is slower** (≈ 10 s vs 5 s)
and the difference between arms is smaller than that cold/warm effect. Build time is NOT COMPARABLE between
arms in this run; the report keeps all three samples.

Experimental Node-only: startup 58–68 ms (all arms); RSS after start 83–87 MB, after load 125–150 MB with no
arm distinguishable. Not a Worker metric.

### The idiomatic-handler diagnostic (surprising result, investigated)

A first run used the idiomatic h3 handler (`return product`) for the native route and showed the **native**
arms ≈ 2 ms slower on workerd API (A/C ≈ 4.5 ms vs B/D ≈ 2.7 ms). With
`STRATA_PERF_NATIVE_HANDLER=object` the effect reproduces (workerd API p50 A 6.14 / C 6.03 ms vs B 2.61 /
D 2.47 ms; Node unchanged). The cause is how the handler produces the body (h3 serializes an object through its
Node-compatible response path, a web `Response` bypasses it), not Strata. The default arms therefore use a
`Response` in both implementations; the finding is recorded so nobody reads "controllers are faster than native
Nitro" out of it. (It is a measurement of h3 on workerd, not a recommendation, and not an optimization here.)

### Correctness and confidentiality

All four arms PASS on both presets and both runtimes: build, marker matrix (server graph contains the page
implementation, repository, transitive helper, private note/cost and the arm's own API handler; browser
output contains the island marker; for C/D none of the server-owned values; for B/D the controller marker is
absent from the browser; for A/B the private values are **present** in the browser, proving the scanner
sees them), source-map package check, SSR/API contract, hydration reuse and click smoke. **Arm A contains no
Strata anywhere**: no dependency, lock entry, installed scope, authored import, or built-output reference.

### Negative controls (all rejected)

Live, on copies of built output and source: missing server implementation (marker removed from the server
graph → static scan and SSR evidence fail), missing browser functionality (island request target broken →
the smoke fails), missing island code, a private canary leaked into a browser chunk, a baseline importing
`@strata-sc/core`, and a mismatched dependency tuple. Unit tests additionally cover invalid-response exclusion,
file classification, graph totals without double counting, percentile and delta arithmetic (including zero
baselines and missing metrics), JSON completeness and arm assembly.

## Uncertainty and limitations

- Sizes are deterministic on this tuple; they describe a **tiny** application (one island, three pages). Per-island
  and per-controller scaling is unmeasured; do not extrapolate.
- Latency: three repetitions per arm, same-host load generator, loopback, Apple M4. Run-to-run range of p50 is
  often 10–30 % and p95 more; arm differences are within it. Concurrent p95 is noisier still.
- Node latency is not Cloudflare latency; local workerd is not a deployed isolate; loopback is not the internet.
- Startup is a Node process start, not isolate cold start. RSS is Node-only and experimental; **no Worker memory
  metric exists** here.
- Cold start, cancellation/cleanup behavior, resource quotas and deployed latency are out of scope and stay open.
- The server graph is a lexical walk over bundler output (documented in `module-graph.ts`); byte attribution per
  source module is NOT MEASURED (Nitro server maps carry no per-module sizes).
- Not a measurement of real adoption: this is a fixture.

## Candidate future budgets (PROPOSALS, NOT ENFORCED)

| Budget                              | Measured now (this fixture)                          | Candidate                                                                          | Reasoning / uncertainty                                                                                 |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Added browser JS, Server Components | +1.7 KiB gzip, +929 B initial entry                  | ≤ +3 KiB gzip for the one-island fixture                                           | Deterministic, so a tight bound is possible; per-island growth unknown, validate with ≥ 3 islands first |
| Added browser JS, controllers       | 0 B                                                  | exactly 0 B (any browser JS is a regression)                                       | Controllers are server-only by contract                                                                 |
| Added server / Worker output        | +11.1 KiB raw Node, +11.5 KiB / +4.4 KiB gzip Worker | ≤ +20 KiB raw, ≤ +8 KiB gzip over arm A                                            | Deterministic; ≈ 1.7× headroom for adapter growth; Angular SSR dominates (≈ 99 %)                       |
| Build-time regression               | below cold/warm noise                                | none yet; collect ≥ 5 warm builds per arm                                          | A 2× cold/warm spread forbids a percentage budget today                                                 |
| Warm SSR latency regression         | arm differences < noise (≈ 10–30 %)                  | none yet; if any, ≤ +25 % p50 vs arm A in the same interleaved run, p95 unbudgeted | Needs a controlled CI host and more repetitions; p95 too noisy                                          |

None is enforced. The next increment should check whether these hold on a controlled GitHub-hosted runner and,
later, on real Cloudflare Workers.

## Baseline failure observed on main (fixed in this PR)

CI run [38766356854](https://github.com/Andersseen/Strata/actions/runs/38766356854) on `1297271` failed at "Server
Component packed-package consumer" with `npm error Cannot read properties of null (reading 'edgesOut')`: registry
drift (vitest 5, and the 4.1.x series) broke npm 10's peer resolution of `@angular/build`'s optional vitest peer for
every Angular external consumer. The existing consumers now pin `vitest` 4.0.18 as a dev dependency (4.1.x
reproduces the crash, 4.0.18 installs), and the Server Component consumer's single-vite check also accepts the
pinned vitest's own nested vite. `--legacy-peer-deps` was tried and rejected for them because it changes the tree
(extraneous packages, a TypeScript 5.9 declaration diagnostic). The four performance arms do not use the pin: they
install with `--legacy-peer-deps` (and no vitest), which is safe for them because every required peer is declared.

## Conclusions

1. On this tuple Strata's incremental bundle cost is small and deterministic: ≈ 0 browser bytes for controllers,
   +1.7 KiB gzip browser and +4.4 KiB gzip Worker (+11 KiB raw server) for both capabilities together, with no
   measurable interaction.
2. No latency or RSS effect is detectable above host noise; do not claim one in either direction.
3. The earlier-measured large server growth does not occur in this architecture.
4. None of R13, resource/cold-start, or any 1.0 gate is closed.

Recommended next increment: a controlled, repeated measurement of these same budgets on the GitHub-hosted runner
(and a scaling variant with several islands/controllers) to learn which candidate budgets are stable.
