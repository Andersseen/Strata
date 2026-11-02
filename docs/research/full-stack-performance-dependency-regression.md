# Full-stack performance baseline: dependency-tree comparability regression

Date: 2026-11-02  
Starting `main`: `f635237d7efcf93c9adcd707665f5227016aa887`  
Branch: `fix/full-stack-performance-baseline`  
Failed hosted run: [41440983466](https://github.com/Andersseen/Strata/actions/runs/41440983466) (scheduled Extended, `main` at `6beb4207`)

This is a repair of benchmark tooling and fixtures. It changes no published package, adds no performance threshold and
closes no 1.0 gate. The original dated baselines ([baseline](full-stack-performance-baseline.md),
[scaling](full-stack-performance-scaling.md)) keep their historical values; numbers below are a **new** run.

## What failed

The job "Full-stack performance baseline (Node + local workerd)" built, smoke-tested and measured all four arms, then
refused the comparison, correctly:

- `all 4 arms lock the identical 824 non-Strata package entries`: the only difference was
  `node_modules/@standard-schema/spec`: absent in arm A and C, `1.1.0` in arm B and D.
- A later report check, `tuple differs between arms`, followed from the same cause.

## Root cause

`@strata-sc/analog` declares `@standard-schema/spec@1.1.0` as a runtime dependency (`packages/analog/package.json`).
Arms B and D install Analog, so npm adds that package; A and C do not. The shared fixture
(`tests/full-stack-performance/fixture/common/package.json`) pinned every Angular/Analog/Nitro/Vite/TypeScript
dependency but could not know about a transitive third-party package Strata would later acquire. When the baseline was
created, none of Strata's packages had a third-party runtime dependency, so the shared pin set was complete by
accident, not by construction. Only this one package differs; the guard compares every locked path, version and
integrity, and reported no other difference.

Classification of the difference: a **transitive dependency introduced by Strata**, not a harness dependency and not an
application bundle difference. It is genuinely a real installation difference between the arms; it is normalised, not
hidden (below).

## Fix

`@standard-schema/spec` is pinned to `1.1.0` in the common fixture, so all four arms lock the same version and
integrity. Nothing imports it: it is installed but not part of any application bundle, so browser and server graphs are
unaffected (confirmed: arms A and B still have identical browser JS, 0 B).

Why this is valid: the benchmark compares **application bundle and runtime behaviour under one controlled dependency
environment**. Equalising the tree removes an installed-package asymmetry that has no effect on the measured graphs.
It does **not** claim Strata costs nothing to install: arms B and D still install `@strata-sc/core` and
`@strata-sc/analog` (and D, C `@strata-sc/server-components`) from packed tarballs, and the native arms contain no
`@strata-sc/*` package. Installation footprint is a separate metric and is not measured here.

Rejected alternative: filtering `@standard-schema/spec` out of the tuple comparison. That would make the guard blind to
exactly the class of drift it exists to catch.

## Hardening

- **Pin completeness guard** (`unpinnedStrataDependencies`): before any install, the runner requires every third-party
  runtime dependency declared by `core`, `analog` and `server-components` to be pinned to the identical version in the
  fixture. A future Strata dependency, or a bumped range, fails fast with the package, owner and both versions, and the
  same check runs as a unit test against the real manifests in `pnpm test:performance-tools`.
- **Actionable diagnostics** (`tupleMismatches`): each line gives the package path, the reference arm and its
  `version integrity`, the other arm and its value, and the reason (`unexpected package`, `missing package`,
  `different resolved version`, `same version, different integrity`).
- **Framework duplication** (`duplicatedFrameworkPackages`): a nested second `@angular/core`, `@angular/compiler` or
  `typescript` in any arm's lock fails the run (in addition to the existing installed-copy check).
- The `report.tupleIdentical` validation and the existing strict tuple negative control are unchanged.
- Native-baseline isolation (manifest, sources, lock, `node_modules/@strata-sc`, built output) is unchanged.
- Three new runtime negative controls: `missing-dependency` (the Standard Schema case), `altered-integrity`,
  `duplicated-framework`. The controls now total 9 (one island) and 14 (three islands), all rejected.

Unit coverage added (`pnpm test:performance-tools`, 163 to 172 tests): the Standard Schema case, the corrected identical
tuple, a version mismatch, a missing dependency, same-version altered integrity, framework duplication, and the pin
guard against the real manifests. The contaminated-native-baseline case was already covered and still passes.

## Results (local, new run)

Machine: Apple M4 (macOS arm64), Node v22.23.1, Wrangler 4.135.0 (local workerd, compatibility date 2026-09-21),
`HEAD` `f635237` plus this change (working tree not clean at measurement time). Defaults: 3 repetitions, 3 build
repetitions, 50 warm-up and 200 measured requests, concurrency 8. Both profiles ran back to back on the same machine.
Packed packages: `core` 0.2.2, `analog` 0.12.0, `server-components` 0.14.0 (digests in each `report.json`).

| Profile     | Dependency tuple                            | Correctness A/B/C/D | Negative controls | Verdict |
| ----------- | ------------------------------------------- | ------------------- | ----------------- | ------- |
| 1 island    | identical, 825 non-Strata entries, 16 named | all PASS            | 9 rejected        | PASS    |
| 3 islands   | identical, 825 non-Strata entries, 16 named | all PASS            | 14 rejected       | PASS    |
| Compare 1v3 | COMPARABLE                                  | n/a                 | n/a               | PASS    |

One island, browser JS (node-server output): A and B 267.4 KiB (gzip 81.6), C and D 280.4 KiB (gzip 86.1). Server
graph (Node): A 1202.0, B 1206.2, C 1214.6, D 1218.7 KiB. Worker (workerd): A 722.2, B 748.2, C 729.0, D 755.0 KiB.
Three islands, browser JS: A and B 270.1 KiB, C and D 282.5 KiB (gzip 86.4). Latency distributions, per-repetition
orders and the budgets table are in the reports (`report.json`, `summary.md`, `comparison.md` from the run; raw
artifacts are not committed).

The 825 count is 824 plus the previously missing Standard Schema package. The earlier dated baselines recorded 819
entries; the 5-entry difference to 824 is unrelated to this regression (npm resolved newer transitive versions under
the pinned direct dependencies) and was not investigated further here. Do not compare absolute numbers with the
2026-10-16 tables: different Strata versions, dependency resolutions and Chromium/Node builds.

Latency in these runs is single-machine, shared with the load generator, and is not asserted. Differences of a few
percent are inside run-to-run noise; no latency or size gate exists.

## Local versus hosted evidence

Local: both profiles, comparison, unit tests, all four arms on Node and workerd and Chromium hydration: executed above.
Hosted: the Extended workflow was **not** run against this branch from this session. It is manual or weekly and reports
success only when the benchmark passes; the job uploads evidence with `always()`. Hosted verification of the fix is
therefore pending until Extended is dispatched (see the PR).

## Limits that remain

Cold start on real Cloudflare infrastructure, Worker memory, production cancellation and cleanup, enforced budgets,
controller or provider-count scaling and real-application adoption remain unmeasured. The 1.0 performance/resource gate
is not satisfied.
