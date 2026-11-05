# M5 production qualification: reproducible candidate, scaling, deployment-aware rollback

**Status:** implemented on `stabilize/m5-production-qualification`
([PR #170](https://github.com/Andersseen/Strata/pull/170)). This is qualification tooling, tests, CI
and documentation. No product API, package, runtime, protocol or rendering mode was added, and no
package version changed. It does **not** qualify production use, M5 or Strata 1.0.

Evidence labels used only where the evidence exists: IMPLEMENTED · UNIT · _Pending: consolidated with the final results._ NODE · _Pending: consolidated with the final results._ WORKERD ·
PACKED CONSUMER · PUBLISHED REGISTRY · _Pending: PR CI and Extended run 42031499769 are in progress; deployed runs 42031494617 and 42033211175 are described in section C; diagnostic run 42034490852 is in progress._ CI · DEPLOYED · REAL APPLICATION.

## Basis

- Starting main: `54a02018caaf4f1bdb73c0fcef280556c87c7bb4` (merge of PR #168; local `main` =
  `origin/main` on 2026-11-05). Final implementation SHA: see the PR head (recorded under
  [Hosted results](#hosted-results)).
- npm on 2026-11-05 (`latest` = `next` for each): `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.12.0,
  `@strata-sc/server-components` 0.14.0. `@strata-sc/h3` is private (registry 404).
- `@strata-sc/analog` **0.12.1 is not published.** The PR #168 patch Changeset
  (`.changeset/drained-body-limits.md`) is pending; the manifest is still 0.12.0;
  `pnpm release:state` classifies the repository as `VERSION_REQUIRED` (one non-empty Changeset).
  Every published-registry claim below uses 0.12.0. The keep-alive fix is therefore qualified
  from source and packed tarballs only, never from the registry.
- Release tags present: `@strata-sc/core@0.1.0…0.2.2`, `@strata-sc/server-components@0.1.0…0.14.0`; no
  `@strata-sc/analog@*` tag and no release-candidate tag. None was created.
- Open issue: #117 (exact-CI release gate; still open, see [Release](#release-and-operational-contracts)).
- Local machine: macOS 26 (Apple Silicon), Node 22.23.1, npm 10.9.8, pnpm 10.30.1, Playwright 1.62.1
  (Chromium 151.0.7922.34).

## What changed

| Workstream                | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Reproducible candidate | `tools/release/lib/candidate.ts` (identity record, lock digest, refusals; UNIT), `--frozen` and `STRATA_CANDIDATE_CAPTURE` in the registry install path, `pnpm test:full-stack-frozen-candidate`, committed candidate `tests/full-stack-candidate/`                                                                                                                                                                                    |
| B. Resource qualification | `STRATA_PERF_CONTROLLERS=8` scaling profile (`tests/full-stack-performance/fixture/controllers-8`, `tools/performance/lib/api-scale.ts`): eight controllers or 32 equivalent native routes, request-scoped ledger, guard, Standard Schema, 1 MiB limit, failing handler; mixed failure burst; cleanup accounting; keep-alive after 413; Linux kernel peak RSS; report schema 3 (reads version 2)                                       |
| C. Upgrade/rollback       | Default published pair moved to `server-components` 0.13.0 → 0.14.0; deployment-aware phase (A → B → retained A on one stable origin, stale clients get the previous deployment's real assets) as _Pending: consolidated with the final results._ REHEARSAL by default and DEPLOYED via the manual workflow (`source: upgrade-rollback`) only to the allowlisted `strata-fullstack-qualification` preview branch `m5-upgrade-rollback` |
| D. Release/operations     | Test of the exact pending analog transition; diagnostics review; maintainer runbook (below)                                                                                                                                                                                                                                                                                                                                            |
| E. Exit audit             | [Traceability matrix](#10-exit-criteria-traceability) of all 32 criteria                                                                                                                                                                                                                                                                                                                                                               |
| G. CI                     | Extended: `registry-frozen-candidate` and `performance-scaling` jobs (weekly + manual), upgrade/rollback job includes the rehearsal (timeout 60 min); manual Cloudflare workflow gains `upgrade-rollback`. Nothing new in mandatory PR CI (all of it needs the registry or is long)                                                                                                                                                    |

Defects found in **product packages: none.** Findings in tooling and the ecosystem are listed under
[Findings](#findings).

## A. Reproducible release candidate

### Two install modes

| Mode                      | Command                                                                 | Purpose                      | Install                                                          |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| FRESH INSTALL (unchanged) | `pnpm test:full-stack-registry-consumer`                                | detect ecosystem drift       | `npm install` of pinned direct dependencies, transitive floating |
| FRESH + capture           | `STRATA_CANDIDATE_CAPTURE=<dir> pnpm test:full-stack-registry-consumer` | record a qualified tree      | as above; written **only if every check passed**                 |
| FROZEN CANDIDATE (new)    | `pnpm test:full-stack-frozen-candidate`                                 | reproduce the qualified tree | `npm ci --legacy-peer-deps` of `tests/full-stack-candidate`      |

Both modes run the identical consumer contract afterwards: declarations (TypeScript 6.0.3 and 5.9.2), public
API inventory, Node production (controllers, safe errors, request lifecycle, guards/authorization, Standard
Schema, SSR, hydration, island, document navigation, Back/Forward), server-only firewall, graph and source-map
confidentiality, negative controls, Cloudflare Pages build and local workerd, Chromium.

New identity checks run in **both** modes, for the consumer and the TypeScript 5.9 declaration consumer:
every locked package resolved from `https://registry.npmjs.org/` with an exact version and sha512 (bundled
dependencies are covered by their parent's integrity); one instance of each framework singleton (Angular,
Strata, RxJS, TypeScript, H3, Nitro) and one Vite on the build path; no `@strata-sc/h3`; every installed
package is exactly its lock entry's version.

FROZEN additionally refuses (UNIT negative controls for each): a registry whose tarball or integrity changed
for the recorded version; a lock whose digest differs; a Strata lock entry with another version, URL or
integrity; a fixture manifest whose direct dependencies no longer equal the candidate's (recapture, never
reuse); a different Node major, Playwright, Wrangler, compatibility date or flags. A version missing from npm
is NOT AVAILABLE (exit 3), never substituted. The exact Node and Chromium builds are recorded and reported,
not required.

Why `--legacy-peer-deps` for `npm ci` (FINDING F1): the fresh tree contains `@analogjs/content@2.9.6`
(transitive, floating), which declares an **optional peer** `sharp ^0.33.5`, while Wrangler's `miniflare`
pins `sharp 0.35.4`. `npm install` accepts that invalid optional peer and writes a lock that `npm ci`'s strict
validation then rejects (`0.35.4 does not satisfy @img/sharp-win32-x64@0.33.5`, `Missing: color@4.2.3`). The
flag only stops npm from re-solving peers while validating; the result is still proven equal to the lock
entry by entry and by digest (the lock was byte-identical after `npm ci`), and the framework peer check still
runs. `npm ls` reports the same 8 problems in both modes: `invalid: sharp@0.35.4` and 7 extraneous WASM
optional packages; none touches Angular, Analog, Vite, TypeScript, Nitro or Strata.

### Candidate identity (`tests/full-stack-candidate/candidate.json`)

| Field                                 | Value                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Candidate id                          | `318670103337b243` (sha256 over the Strata integrities and both lock digests)                               |
| Captured                              | 2026-11-05T11:41:22Z from source `54a02018` (branch working tree), macOS arm64                              |
| `@strata-sc/core` 0.2.2               | `sha512-Xr6bMt7funa/RtMhr/BTLX548alI8w5/tq/4QIgvk4INEc4nED5CweQUeEujPU6o9/NcJ1XFtqcXPNGjohkHFA==`           |
| `@strata-sc/analog` 0.12.0            | `sha512-jHkt/GbJ3nMvzwuVzRnDYQ6dfTPpcEN7jm+qGADvP0whTKs56qT/QkR9lmJ9vnSfrxyNgmt8jIl2n963BjWAuA==`           |
| `@strata-sc/server-components` 0.14.0 | `sha512-GoaNuTU/cOJgVme9hyXziAjD7bmszRmxZUah8yaDUcrMv7T5Kw/qgH4IJSqILs6Q8Ng78VssKq5MXugQWkj7bw==`           |
| Tarballs                              | `https://registry.npmjs.org/@strata-sc/<name>/-/<name>-<version>.tgz`; downloaded bytes = registry = lock   |
| Consumer tree                         | 869 locked packages, lockfile v3, digest `28a16992283be8018b1226254f58bc6a0d5074329d810ecccdadeb0c43b38295` |
| TypeScript 5.9 tree                   | 80 locked packages, digest `fde4933973df336dff094bb9e879cd313026a3bf3f6e3d447aa8f43ea7bb209e`               |
| Toolchain at capture                  | Node v22.23.1, npm 10.9.8, Playwright 1.62.1, Chromium 151.0.7922.34, Wrangler 4.135.0                      |
| Cloudflare                            | Pages preset, compatibility date 2026-09-21, flags: none (`nodejs_compat` deliberately off)                 |

The lock is platform-independent (lockfile v3 lists every optional platform binary; 288 were absent on
macOS), so the same candidate is reinstalled on hosted Linux.

### Compatibility tuple of the candidate (resolved, not only declared)

Angular 22.2.3 (core, common, compiler, compiler-cli, platform-browser, platform-server, router),
`@angular/build` 22.1.8; Analog platform/router/vite-plugin-angular 2.7.2, `@analogjs/vite-plugin-nitro`
2.9.6; nitropack 2.13.4; h3 1.15.11; Vite 8.3.0; Rolldown 1.2.0; esbuild 0.27.7; TypeScript 6.0.3 (declarations
also 5.9.2); RxJS 7.8.2; tslib 2.8.1; zod 4.6.5; Wrangler 4.135.0, workerd 1.20260918.1, miniflare
5.20260918.0-alpha.

### Results

| Run                                 | Result                                                                                     | Evidence                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Fresh registry, first attempt       | FAIL on two of the new identity checks — both classification gaps in the new code (F2, F3) | _Pending: consolidated with the final results._ |
| Fresh registry + capture            | **PASS, 0 failing**; candidate written                                                     | PUBLISHED REGISTRY                              |
| Frozen, plain `npm ci`              | FAIL: npm refuses its own lock (F1)                                                        | PUBLISHED REGISTRY                              |
| Frozen, `npm ci --legacy-peer-deps` | **PASS, 0 failing** (Node, workerd, Chromium, declarations, public API, confidentiality)   | PUBLISHED REGISTRY                              |

## B. Production resource qualification

_Pending: the local one-island and three-island profiles are still running; the three-island + eight-controller profile and the hosted Extended results are recorded in the next update of this report._

## C. Published upgrade and rollback

### Pair

Release A = core 0.2.2, analog 0.12.0, **server-components 0.13.0**; release B = the same with
**server-components 0.14.0**. All six versions verified on npm before building; analog pins core 0.2.2 in
both. analog 0.12.1 is NOT AVAILABLE, so no pair with the keep-alive patch exists yet. Build ids
`upgrade-a-2026.11.5` / `upgrade-b-2026.11.6` (deployment labels, never package versions). Every non-Strata
package resolved to the same version and integrity in both installs, so differences are attributable to
the Strata packages.

### Local qualification (unchanged scenarios, new pair)

_Pending: consolidated with the final results._ NODE + _Pending: consolidated with the final results._ WORKERD + Chromium, PUBLISHED REGISTRY: **PASS, 0 failing checks.** Each release
independently passes the full-stack contract and graph confidentiality; the two-build edge proves same-release
hydration, build-mismatch refusal in both directions naming both builds, sibling-host isolation, bounded
recovery (one reload when the edge converges, `exhausted` without a loop when it does not), the full
A → B → A sequence in one tab with Back/Forward, and the negative controls (stripped identity →
`build-identity`; forged id → mismatch). A's artifact is byte-identical at rollback and restarted, not rebuilt.

### Deployment-aware phase

Steps: D1 deploy A and verify the alias (full contract, build stamps, immutable URL); D2 open a tab on A;
D3 deploy B and verify, A still served at its immutable URL; D4 the open A tab against B's API, a document
navigation to B, Back/Forward; D5 B document with **A's real deployed scripts** (recovery off → refused;
converging cache → one reload; persistent → `exhausted`); D8 restore A's retained artifact (digest checked),
verify, and the mirror skew with B's scripts; D9 public-surface confidentiality and the bounded concurrency
matrix (budget 1,500, no retries). Readiness polling is separate from the assertions and recorded.

| Run                                                                                                      | Where                                                          | Result                                                                                                                                    | Evidence                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local rehearsal (macOS)                                                                                  | wrangler ×2 + local alias                                      | **GO**, every D-step; matrix 779 requests, 0 anomalies                                                                                    | _Pending: consolidated with the final results._ WORKERD                                                                                                                            |
| Hosted rehearsal, run [42031494617](https://github.com/Andersseen/Strata/actions/runs/42031494617)       | GitHub runner, same                                            | **GO**, every D-step; 779 requests, 0 anomalies                                                                                           | _Pending: PR CI and Extended run 42031499769 are in progress; deployed runs 42031494617 and 42033211175 are described in section C; diagnostic run 42034490852 is in progress._ CI |
| Real deployment, same run                                                                                | `strata-fullstack-qualification`, branch `m5-upgrade-rollback` | **NO-GO**, 16 failing checks (below)                                                                                                      | DEPLOYED                                                                                                                                                                           |
| Real deployment, second run [42033211175](https://github.com/Andersseen/Strata/actions/runs/42033211175) | same                                                           | **NO-GO**, 15 failing checks: items 2 and 3 recurred (19 anomalies); item 1 did **not** recur (D5 and D8 passed); one new failure (below) | DEPLOYED                                                                                                                                                                           |

What the first real deployment showed, as observed (no root cause is claimed):

1. **The branch alias served the previous deployment after readiness.** After B was deployed and the alias
   answered build B with the controller three times in a row, the D5 converging reload received an **A**
   document; after A was restored, D8 found boundaries that were not A's. Strata behaved as designed every
   time: the mismatch was refused and named both builds (`browser upgrade-b-2026.11.6`, `server
upgrade-a-2026.11.5`), one bounded reload happened, then `exhausted`, the SSR DOM stayed, no loop, no
   unexpected exception, no canary. The failing expectation is the test's "the edge has converged".
2. **Edge matrix: 829 requests, 16 anomalies, REPRODUCED**, all `unclassified / body differs from baseline`
   on `/products/42` and `/products/999` in the combined controller + Server Component bursts after the
   rollback. Controller answers, content types and statuses matched. This is consistent with item 1
   (documents from two builds differ by their build stamps) but the stored samples do not prove it.
   Recorded as unresolved, next to the earlier unexplained anomaly
   ([report](full-stack-cloudflare-concurrency.md)).
3. **Authorization fixture observations.** The guard/ownership status patterns of the 24-overlap matrices
   matched exactly, but the fixture's per-request read counters (`x-fixture-protected-reads`) did not
   (`reads` 0 where 1 was expected). The counters are module state of the Worker; on a multi-isolate edge
   such state is not shared. That explanation is plausible, not verified; these checks were added after the
   last full-stack deployment (2026-11-02) and had never run on a public edge.
4. **Second run** (identical code, dispatched to test reproducibility, not to replace the first): the alias
   behaved consistently (every D5/D8 skew, recovery and stamp check passed), yet the matrix again found
   `body differs from baseline` on SSR pages (19), so item 2 is **not** explained by item 1 alone. Item 3
   recurred with identical status patterns. New: once in three deployed navigation suites,
   `strataDocumentNavigationGuard` saw **2** document requests where 1 is expected (D1 only; D3 and D8 passed,
   and it passed on every local and rehearsal run). Unresolved.
5. The stored samples kept only a 160-character prefix, which cannot show what differed. The classifier now
   adds a bounded `bodyDifference` (offset, lengths, an 80-character window per side, the build stamps of
   each side), withheld whenever either body carries a private value (UNIT). The next deployed run will show
   whether the differing bytes are a build stamp, a per-request value or something else. One hypothesis
   to test, not a finding: items 2 and 3 share a cause, Worker module state (fixture counters) that differs
   per isolate on a multi-isolate edge and is a single value in local workerd.
6. Everything else on the public alias passed in both runs: SSR, controller API, hydration, interaction, document
   navigation, Back/Forward, build stamps on immutable URLs, D4, the recovery-off and persistent-skew
   refusals, public surface confidentiality.

Consequence for operations: a Pages branch alias must not be assumed atomic right after `wrangler pages
deploy`, even after several consecutive correct answers. Build identity plus opt-in recovery is what keeps a
mixed edge safe; verification of a specific deployment should use its immutable URL.

## Release and operational contracts

### Release state (D1, D2)

| Fact                 | Observed 2026-11-05                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Manifest versions    | core 0.2.2, analog 0.12.0, server-components 0.14.0 (h3 0.1.0, private)                                             |
| Pending Changesets   | 1 non-empty (`drained-body-limits.md`, analog patch) + 6 empty; no duplicate added by this work                     |
| `pnpm release:state` | `VERSION_REQUIRED` (read-only; no registry call needed)                                                             |
| npm                  | analog 0.12.1 **not published**; dist-tags `latest` = `next` for every package                                      |
| Release workflow     | last runs 41888506615 / 41847834923 succeeded (classified no-op / earlier publish); nothing dispatched by this work |

Unit coverage of the classifier and gate was audited against every required state and already covers
VERSION_REQUIRED, PUBLISH_REQUIRED (incl. partial), ALREADY_PUBLISHED, BLOCKED (placeholder version, dependency
mismatch, registry timeout / 401 / malformed metadata), empty Changesets, failed / cancelled / pending
`Verify`, failed / cancelled overall CI, stale main SHA, API errors and dist-tag read-after-write lag. Added:
the exact pending transition (now VERSION_REQUIRED without any registry call; after the Version Packages PR,
PUBLISH_REQUIRED with **only** `@strata-sc/analog` unpublished). UNIT only. **Issue #117 stays open**: hosted
cancelled, pending and stale-main Release transitions have still not been observed; simulations do not prove
them. No package was published and no dist-tag was changed.

### Diagnostics (D3)

Reviewed surfaces and the evidence that they keep private data out, all existing or new automated checks:

| Surface                   | What reaches a client or log                                                                     | Evidence                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Unhandled handler failure | Nitro's generic 500; the thrown private text never in the body (Node and workerd, all four arms) | scaling burst (new): `PERF_SCALE_PRIVATE_FAILURE_CANARY` absent in every 500 |
| Safe HTTP errors          | status + safe code; 401/403/404/422 without message exposure                                     | full-stack consumer, packed + registry + frozen                              |
| Validation failure        | `400` with `source`, no echoed input; 413 without body echo                                      | full-stack consumer; scaling burst                                           |
| Failed SSR / hydration    | one `ErrorHandler` report, SSR DOM kept, no private canary in DOM/console                        | failures suite, upgrade/rollback, rehearsal D5/D8                            |
| Build mismatch            | `StrataBuildMismatchError` naming only the two public build ids; tab record `{count,since}` only | upgrade/rollback edge + rehearsal                                            |
| Cleanup failure           | `cleanup-failed` 500, no detail                                                                  | packed DI consumer (PR #168)                                                 |
| Server logs               | no private canary in Node/workerd output                                                         | upgrade/rollback contract                                                    |
| Edge anomalies            | classified samples hold status, content type, edge headers; never request bodies or credentials  | concurrency matrix                                                           |

Correlation stays the existing opt-in `requestCorrelation` id. No tracing or telemetry was added.
Deployment credentials are removed from every build/test command and redacted from output by both
deployment runners.

### Maintainer runbook (D4)

**Select the exact tuple.** Use one combination whose analog pins the selected core
(`npm view @strata-sc/analog@<v> dependencies`). Never a range or tag. For the full-stack fixture, the current
qualified tuple is the frozen candidate `318670103337b243` (core 0.2.2, analog 0.12.0, server-components 0.14.0).

**Verify package identity.** `npm view @strata-sc/<name>@<v> dist.integrity dist.tarball` must equal
`tests/full-stack-candidate/candidate.json`; `pnpm test:full-stack-frozen-candidate` checks it together with
the lock digest and every installed version. A different integrity for the same version means stop.

**Reproduce a failed deployment.** Re-run the same candidate frozen (`pnpm test:full-stack-frozen-candidate`);
if it passes locally, compare the toolchain lines it prints with the failing environment. For the A/B path,
`STRATA_UPGRADE_{A,B}_*_VERSION=… pnpm test:full-stack-registry-upgrade-rollback` reproduces the pair locally,
including the deployment rehearsal; `STRATA_KEEP_CONSUMER=1` keeps the builds.

**Retain and restore an application artifact.** Keep the built `dist/` (or the Pages output directory) of every
release with its digest; a rollback redeploys that artifact (the runner proves the digest is unchanged) — it
never rebuilds from source, because a rebuild is a different application build with a different build id.

**Package rollback vs application rollback.** An application rollback redeploys a retained artifact and is
immediate. A package rollback changes `package.json` to the previous exact versions, reinstalls, rebuilds and
redeploys: it creates a **new** application build (new build id) and must be qualified like an upgrade.

**Interpret a build-mismatch refusal.** The browser's scripts and the document come from different
deployments. Expected right after a deploy; with `provideSkewRecovery` one bounded reload converges once the
edge serves one release. `recovery: "exhausted"` after one reload means the skew persists: check that the
edge/CDN serves documents and `/assets/*` from the same deployment.

**Stop a deployment when:** any frozen or local qualification check fails; the registry integrity differs from
the record; readiness never reaches the expected build id within its bound; the concurrency matrix reports a
controller mismatch, wrong content type or edge 404; a private canary appears anywhere; or build-mismatch
recovery is exhausted after the edge settled.

**Safe diagnostics to retain:** the evidence JSON, check names/results, build ids, deployment hash and id,
status codes, content types, edge headers, timing. Never request bodies, cookies, credentials, private fixture
values or server source. Browser traces are kept only for failures of the public site.

**Recover without exposing data:** restore the retained artifact of the last good release first, then
investigate offline on the frozen candidate; never enable verbose production errors on the public deployment.

## 10. Exit criteria traceability

Every criterion of [RELEASE-1.0](../RELEASE-1.0.md), unchanged (32 items; one was ticked before this work and
none is ticked or unticked by it). PARTIAL is not a completed criterion.

| #   | Criterion (abridged)                                                           | Existing implementation / evidence                                                                                                                        | Still missing                                                                                                                  | Blocking dependency              | Owner             | Next qualifying action              | Status  |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------- | ----------------------------------- | ------- |
| 1   | Stable documented public API                                                   | Machine-checked inventory, declaration=runtime parity                                                                                                     | Stability/deprecation policy, docs completeness                                                                                | SemVer policy (#26)              | core/analog/sc    | Write the SemVer/deprecation policy | PARTIAL |
| 2   | Controllers, inputs, validation, errors, lifetimes, authorization in real apps | Packed/registry/frozen fixtures; scaling profile adds 8 controllers, guard, request-scoped ledger under a mixed burst                                     | Real application                                                                                                               | Real adoption (#29)              | analog            | Adopt in a real consumer            | PARTIAL |
| 3   | Angular/Analog integration dev + prod                                          | Packed DI matrix (Node); frozen candidate reproduces the full consumer                                                                                    | workerd Angular DI (NO-GO, upstream JIT); shared SSR/controller injector                                                       | Angular JIT on workerd           | analog            | Keep NO-GO documented; real app     | PARTIAL |
| 4   | No legacy decorators / reflect-metadata                                        | Standard decorators only; consumers compile strict                                                                                                        | A formal release audit record                                                                                                  | —                                | core              | Record in the release evidence      | PARTIAL |
| 5   | Core independent; owned package responsibilities                               | Package graph and public API inventory                                                                                                                    | Release-audit record                                                                                                           | —                                | all               | Record in the release evidence      | PARTIAL |
| 6   | Native H3 routes and Analog serverFn coexist                                   | Native route beside controllers (all fixtures); serverFn on Node                                                                                          | serverFn on workerd (NO-GO)                                                                                                    | Angular JIT on workerd           | analog            | Keep documented                     | PARTIAL |
| 7   | Actual server/client graph split                                               | Graph suites, packed and registry consumers, both presets                                                                                                 | Release candidate record                                                                                                       | —                                | server-components | Release evidence record             | PARTIAL |
| 8   | Server code out of every browser chunk/asset/map                               | Leak scanners with positive controls (also in the scaling profile and every frozen run)                                                                   | Release record; deployed surface for full stack is one run                                                                     | —                                | server-components | Release evidence record             | PARTIAL |
| 9   | Server-only deps excluded transitively, fail closed                            | Firewall suites (direct/dynamic/barrel/defer/raw/url)                                                                                                     | Package re-exports not crawled; non-asserting module undetected                                                                | Design limit                     | server-components | Keep documented as unsupported      | PARTIAL |
| 10  | Interactive descendants hydrated without server parent                         | Hydration, DOM reuse, exactly-once events; 1/3 islands                                                                                                    | Release record; real app                                                                                                       | Real adoption                    | server-components | Real app                            | PARTIAL |
| 11  | Initial SSR, direct URL, request isolation                                     | Request-context and isolation suites, 24 overlaps, authorization fixture                                                                                  | Tenant/cache isolation in production                                                                                           | Real adoption                    | server-components | Real app                            | PARTIAL |
| 12  | One production-safe navigation strategy                                        | Document navigation supported; Back/Forward verified incl. deployed rehearsal                                                                             | Router subtree hydration UNSUPPORTED (deliberately)                                                                            | —                                | server-components | Production evidence on a real app   | PARTIAL |
| 13  | Hydration and @defer composition rules                                         | interaction/viewport triggers; server-owned @defer refused                                                                                                | Other triggers, nested islands, deployed                                                                                       | —                                | server-components | Extend only if needed               | PARTIAL |
| 14  | Serialization, limits, identity, version skew                                  | v1/v2 protocols, 128/1 MiB budgets, build identity; A/B skew local + rehearsal                                                                            | Protocol stability promise; deployed skew (see #21)                                                                            | Deployed A/B                     | server-components | Deployed upgrade/rollback           | PARTIAL |
| 15  | Render/serialization/navigation/hydration failures safe                        | Failure suites; streaming unsupported                                                                                                                     | Unexpected render failure still HTTP 200                                                                                       | No public Angular/Analog seam    | server-components | Decide accepted contract or seam    | BLOCKED |
| 16  | Authorization, isolation, redaction, leak negatives                            | Adversarial and authorization suites; private failure text absent under burst (new)                                                                       | Production auth/tenant/cache isolation; log redaction in real deployment                                                       | Real adoption                    | all               | Real app                            | PARTIAL |
| 17  | Production fixture deployed                                                    | Full-stack published tuple deployed once (2026-11-02)                                                                                                     | Repeated deployed evidence of the current candidate                                                                            | —                                | maintainers       | Deployed frozen candidate           | PARTIAL |
| 18  | Supported Node version and built entry validated                               | Node 22.23.1 local / Node 22 hosted, Nitro node-server entry in every suite                                                                               | No Node server deployment                                                                                                      | Hosting target                   | maintainers       | Deploy a Node server                | PARTIAL |
| 19  | Cloudflare complete path with preset/date/flags/bindings                       | Pages preset, 2026-09-21, no flags recorded; full-stack deployed once                                                                                     | Bindings not exercised; Angular DI on workerd NO-GO                                                                            | Angular JIT                      | maintainers       | Keep scope explicit                 | PARTIAL |
| 20  | Resources, cold start, concurrency, cancellation, cleanup; budgets             | This report: scaling dimension, burst cleanup, RSS, startup, sizes                                                                                        | Cloudflare isolate cold start and Worker memory NOT MEASURED; cancellation unsupported through adapters; budgets informational | Platform tooling; adapter signal | maintainers       | See budget decision                 | PARTIAL |
| 21  | Release/rollback incl. older client assets                                     | Published 0.13.0→0.14.0 local Node+workerd, _Pending: consolidated with the final results._ REHEARSAL GO; DEPLOYED: NO-GO (runs 42031494617, 42033211175) | Real consumer rollback                                                                                                         | Real adoption                    | maintainers       | Repeat for the next published pair  | PARTIAL |
| 22  | Unit/adapter/integration/SSR/hydration/navigation tests pass                   | Mandatory CI + Extended                                                                                                                                   | Release-candidate record                                                                                                       | —                                | maintainers       | Release evidence record             | PARTIAL |
| 23  | Bundle assertions and leak detectors with positive controls                    | Performance and consumer leak scanners with positive controls                                                                                             | Release record                                                                                                                 | —                                | maintainers       | Release evidence record             | PARTIAL |
| 24  | Small explicit compatibility matrix with CI links                              | Exact tuple + frozen candidate identity (COMPATIBILITY)                                                                                                   | One tuple only; hosted frozen run pending at writing                                                                           | —                                | maintainers       | Hosted frozen run; second tuple     | PARTIAL |
| 25  | Published candidate installs cleanly outside the workspace                     | Ticked earlier for server-components; now full tuple fresh and frozen from npm                                                                            | —                                                                                                                              | —                                | maintainers       | —                                   | PASS    |
| 26  | SemVer/prerelease/deprecation/migration policy; upgrades exercised             | Upgrades exercised (two pairs)                                                                                                                            | Policy not written                                                                                                             | —                                | maintainers       | Write policy                        | PARTIAL |
| 27  | Docs, examples, diagnostics, H3 escape hatch                                   | Package READMEs, runbook (this report)                                                                                                                    | Complete public docs                                                                                                           | —                                | maintainers       | Docs pass                           | PARTIAL |
| 28  | RISKS blockers have dispositions                                               | Register maintained                                                                                                                                       | Several open (R13, R21, cancellation, render 200)                                                                              | Upstream                         | Astra/maintainers | Disposition review                  | PARTIAL |
| 29  | Real application uses the production path                                      | —                                                                                                                                                         | Everything                                                                                                                     | Separate controlled phase        | consumer          | ForgeCMS or equivalent              | NOT RUN |
| 30  | Prefer ForgeCMS / record suitability                                           | —                                                                                                                                                         | Everything                                                                                                                     | As above                         | consumer          | As above                            | NOT RUN |
| 31  | Record consumer revision, candidate, deployment, observations                  | Candidate identity record exists                                                                                                                          | Consumer side                                                                                                                  | As above                         | consumer          | As above                            | NOT RUN |
| 32  | Consumer migration and rollback verified                                       | —                                                                                                                                                         | Everything                                                                                                                     | As above                         | consumer          | As above                            | NOT RUN |

Totals: PARTIAL 26, BLOCKED 1, PASS 1, NOT RUN 4. **Not 1.0-ready.**

## Findings

_Pending: consolidated with the final results._

## Hosted results

_Pending: PR CI and Extended run 42031499769 are in progress; deployed runs 42031494617 and 42033211175 are described in section C; diagnostic run 42034490852 is in progress._

## Local verification

_Pending: consolidated with the final results._
