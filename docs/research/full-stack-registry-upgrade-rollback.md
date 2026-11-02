# Full-stack Strata: published-registry upgrade and rollback qualification

Date: 2026-11-02  
Baseline: `d894d135c7231735e4454788fca096af64344da4` (`main` after PR #161)  
Branch: `test/registry-upgrade-rollback`

## Verdict first

**LOCAL UPGRADE/ROLLBACK QUALIFIED** for one exact published pair, on Nitro Node production and **local**
workerd (`wrangler pages dev`), observed in Chromium.
**REAL DEPLOYED UPGRADE/ROLLBACK: NOT RUN.** Local workerd is not a Cloudflare deployment, and nothing was
deployed, published or retagged.

| Level                                               | Result                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unit qualified (pair selection, build-id pattern)   | 5 vitest cases in `tools/release/lib/upgrade-pair.test.ts`                                              |
| **Local upgrade A → B qualified (Node + workerd)**  | **PASS**, `pnpm test:full-stack-registry-upgrade-rollback`: 988 checks, 0 failing                       |
| **Local rollback B → A qualified (Node + workerd)** | **PASS** (same run; rollback restarts A's own, byte-identical artifact and re-runs the whole contract)  |
| Stale-asset skew, both directions                   | Classified `build-mismatch` on both runtimes; bounded recovery converges; fails closed when it does not |
| Real deployed upgrade/rollback                      | **NOT RUN** (see "Reproducing it on a real deployment")                                                 |
| Production adopted                                  | **NO.** One synthetic application and two published versions                                            |

This does not prove arbitrary-version interoperability, other Angular/Analog/Nitro tuples, authentication,
tenant caching, shared controller/SSR Angular DI, subtree Router navigation or streaming SSR. M4, M5 and Strata
1.0 are not closed. The historical unexplained Cloudflare concurrency anomaly stays an open risk.

## The gap

The existing deployment-skew gate (`pnpm test:server-component-deployment-skew`) proves the skew contract with
two builds of one **source-packed** package whose _application code_ differs. The registry gate
(`pnpm test:full-stack-registry-consumer`) proves one published tuple. Nothing showed that a consumer can
move between two **published** Strata combinations, with the stale-asset behaviour a real upgrade or rollback
exposes, and back.

## Release pair

Both versions exist on npm (checked before the run) and are coherent: the published `@strata-sc/analog@0.12.0`
pins `@strata-sc/core@0.2.2` in both releases.

| Release | `@strata-sc/core` | `@strata-sc/analog` | `@strata-sc/server-components` | Application build id  |
| ------- | ----------------- | ------------------- | ------------------------------ | --------------------- |
| A       | 0.2.2             | 0.12.0              | **0.12.0**                     | `upgrade-a-2026.11.1` |
| B       | 0.2.2             | 0.12.0              | **0.13.0**                     | `upgrade-b-2026.11.2` |

| Package                        | Integrity (sha512, equal to the registry's, the lock's and a re-downloaded tarball's)      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `core@0.2.2` (both)            | `Xr6bMt7funa/RtMhr/BTLX548alI8w5/tq/4QIgvk4INEc4nED5CweQUeEujPU6o9/NcJ1XFtqcXPNGjohkHFA==` |
| `analog@0.12.0` (both)         | `jHkt/GbJ3nMvzwuVzRnDYQ6dfTPpcEN7jm+qGADvP0whTKs56qT/QkR9lmJ9vnSfrxyNgmt8jIl2n963BjWAuA==` |
| `server-components@0.12.0` (A) | `8OiBJZGE3EX86/91hEpZxRpK0+EqzEnAKjId5qp0RIto7BejDoKGhbkEMTMc/t3Bo+Es4uOP8Hv1ddODNTJTmA==` |
| `server-components@0.13.0` (B) | `xoJRA5ZSnuWPRwQNk/lUAhiZssamn+Qk9LvPyeD78NLKaLZmNuN7DNCD3PT0f5tNJy1AX8ViC/zjlDxsaoh5Lg==` |

The only difference between the two installed Strata trees is in `@strata-sc/server-components`: three files
(`package.json`, `dist/fesm2022/client-references.js` and its map: the 0.13.0 client-reference validation
hardening). Core and Analog are byte-identical. A and B are therefore a genuine but small published delta;
the evidence says "this upgrade works", not "any upgrade works".

Installed in both consumers (identical, asserted): Angular core/common/compiler/router/platform-browser/
platform-server 22.2.3, `@angular/build` 22.1.8, `@analogjs/platform` and `router` 2.7.2,
`@analogjs/vite-plugin-nitro` 2.9.5, nitropack 2.13.4, h3 1.15.11, Vite 8.3.0, TypeScript 6.0.3, rxjs 7.8.2,
Wrangler 4.135.0, Node v22.23.1.

The pair is configurable with exact versions only (a tag or range exits 2; an unpublished version exits 3,
NOT AVAILABLE, nothing substituted):
`STRATA_UPGRADE_{A,B}_{CORE,ANALOG,SERVER_COMPONENTS}_VERSION`, `STRATA_UPGRADE_{A,B}_BUILD_ID`,
`STRATA_UPGRADE_RUNTIMES=node,cloudflare`, `STRATA_UPGRADE_EVIDENCE=<path>`. PR #158 (`0.14.0`) is not on npm,
so it is not used; once published, `STRATA_UPGRADE_B_SERVER_COMPONENTS_VERSION=0.14.0` qualifies it.

## What was reused, what is new

Reused unchanged: `installRegistryConsumer`/`lookupTuple` (registry lookup, lock/integrity/byte-identity/
single-copy checks, with the tampered-lock negative control), `verifyInstalledTree`, the `Edge` reverse proxy
and `entryScript`/`filesContaining` of the deployment-skew gate, `startNodeServer`/`startWrangler`,
`httpSuite`, `islandSuite`, `navigationSuite`, `routingSuite`, `routingBrowserSuite`, the streaming and
correlation observers, `provideSkewRecovery` and its reload budget.

New, kept small:

- `tools/server-components/registry-upgrade-rollback.ts` (the command) and
  `tools/server-components/lib/upgrade-rollback.ts` (pair/build-id selection, `buildInstalledRelease`,
  tree digests, the in-page observer).
- `lib/full-stack-declarations.ts`: the declaration-portability check extracted from `full-stack-consumer.ts`
  so both runners share it (behaviour unchanged).
- Fixture, **opt-in only** (defaults and existing tests unchanged):
  `STRATA_BUILD_ID` → the plugin's `buildId`; `STRATA_STABLE_ENTRY=1` → `assets/entry.js`;
  `VITE_STRATA_UPGRADE_PROBES=1` → browser-only recording `ErrorHandler`, `provideSkewRecovery` (reload only
  with `?recovery=reload`) and a hydration observer (`src/app/upgrade-probes.ts`); a `/pair` page with two
  Server Component hosts. No application source is edited between releases.
- `Edge`'s `upstreams` is now `Partial` (a scenario needs only the releases it names).
- `full-stack-verify.ts`: the boundary-markup regex tolerates the optional `data-strata-build` attribute
  (found by this run: the first Node pass failed it on both A and B). Without a build id it matches exactly as
  before.
- `extended.yml`: a manual/scheduled `registry-upgrade-rollback` job. It is not a PR gate (network-dependent).

Build ids are chosen per **deployment**, never derived from a package version (asserted: neither contains a
package version). Two deployments with identical packages are still different builds.

## Sequence and results

Two independent `npm install`s into two directories outside the workspace (isolated npm config), two
independent `vite build`s per runtime (no compiled output patched), every scenario against genuine A and B
production artifacts served behind the edge.

| Step | Scenario                                                                                    | Node | local workerd |
| ---- | ------------------------------------------------------------------------------------------- | ---- | ------------- |
| A, C | Install + build A, install + build B (lock/integrity/byte identity/declarations/exports)    | PASS | PASS          |
| B, D | Each release verified alone: full-stack contract (below)                                    | PASS | PASS          |
| ctl  | A HTML + A assets, B HTML + B assets: hydrate, committed observation, interactive           | PASS | PASS          |
| F    | **B HTML + stale A assets**: `StrataBuildMismatchError`/`build-mismatch` naming both ids    | PASS | PASS          |
| G    | **A HTML + stale B assets**: same, other direction                                          | PASS | PASS          |
| sib. | One host rendered by the other release beside a healthy host: only it is refused            | PASS | PASS          |
| H    | Recovery on, edge converges: exactly one reload, to the new document, hydrates, interactive | PASS | PASS          |
| I    | Recovery on, skew persists: one reload, then `exhausted`, inert SSR, no further request     | PASS | PASS          |
| E    | One tab: A live → upgrade with stale A scripts → B (reload, hydrate, interactive)           | PASS | PASS          |
| J    | Rollback B → A with stale B scripts: mismatch, one reload, A hydrates                       | PASS | PASS          |
| K    | After rollback: interaction, document navigation, Back, Forward, Back                       | PASS | PASS          |
| J'   | Restart A's own artifact (digest equal to the first verified) + the whole contract          | PASS | PASS          |

Full-stack contract (run for A, for B and again for the rolled-back A, per runtime): real Strata controller
HTTP responses; validated request handling and header/route boundaries; Server Component SSR content and
`data-evidence`; request-scoped lifecycle and cross-request isolation; Angular island hydration reusing SSR
nodes and one-click/one-request interaction; supported document navigation and Back/Forward; streaming and
correlation observers; routing/API boundary in the browser; build id on every boundary; confidentiality of
browser files and maps (every canary absent, every server-only marker present in the server graph); no
console error, failed request or private canary in server output.

For each refused mismatch (F, G) the run asserts: no island instantiated (`hydratedHosts` 0, committed
boundaries 0); the SSR DOM stays visible and a click is inert with no controller request; exactly one
classified `preflight-refused` observation with `failureCategory: "build-mismatch"` and recovery `disabled`;
`onMismatch` receives exactly the two public ids; one document request (recovery is off, no storage record);
no page error, unhandled rejection or non-handler console line; no canary in DOM or console.

### Artifact digests (sha256)

| Runtime    | A `dist/`                                                          | B `dist/`                                                          |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Node       | `20d82a63b48d03c2e10cced0f9b35b0057f221e2521defe2e002fd7ebd365422` | `c062168ee600a08b56526c0a63e35bcd1d9da3d1a0f700e72b4ce9b10ccf64fd` |
| Cloudflare | `398a17c219c602ec770c027fb1eb031d7b020c81443ee5c6ec676e01b57af9e0` | `1a9b64e7450c78c10128fedcb96cbfbfecdb4f24ee6d531499ea88e9ed6400e1` |

`assets/entry.js`: A `d6375f7b…c44325d`, B `8a2ae013…6cdbc` (identical across the two presets). Digests are
build-specific records, not reproducibility claims; the run asserts only that A ≠ B and that A's artifact
did not change between first verification and rollback.

### Request counts and browser observations

- Healthy and refused-without-recovery cases: exactly **1** document request.
- Recovery converges: **2** document requests (stale document, then the reconciled one), the second to the
  same URL; the tab record is `{"count":1,"since":<ms>}` only.
- Recovery cannot converge: **2** requests, then `exhausted`; after a deliberate manual reload, **3** and no
  further automatic reload (waited past network idle plus 1.5 s).
- Whole A → B → A tab: **5** `/products/42` requests (A; B-with-A-scripts; reconciled B; A-with-B-scripts;
  reconciled A).
- Chromium: no page error, no unhandled rejection and no non-handler console line in any scenario; the only
  console errors are the application's own classified `ERROR …` lines for the intentional refusals.

## Negative controls (expected refusals versus genuine failures)

Expected refusals are the F/G/I/negative-control outcomes above: they pass only when classified exactly.
A genuine failure is anything else. Controls that prove the verifier can fail:

- A's document with the build attribute removed, A's scripts: must be `build-identity`, never hydration or a
  reload (pass).
- A's document forged to claim B's id, A's scripts: must be refused as a mismatch, proving the verifier tells
  identities apart independent of package contents (pass).
- Self-test: a healthy hydration is not classified as a mismatch.
- Lock negative control (existing): a corrupted integrity must fail the same verifier.
- A real catch: the first Node run failed the contract's markup check for A, B and the rollback (7 failing
  checks, including an arithmetic error of this runner's own in step J: 5, not 6, product requests). Both
  were fixed in the verifier, not by weakening an assertion.
- Pair selection: tag/range refusal and build-id pattern unit-tested.

## Reproducing it on a real deployment (NOT RUN)

An independently authorised owner can repeat the sequence on the existing isolated project
`strata-fullstack-qualification` (never the official website, DNS, routes or bindings):

1. Install A and B as above; build each with `STRATA_BUILD_ID`, `STRATA_STABLE_ENTRY=1`,
   `VITE_STRATA_UPGRADE_PROBES=1`, `BUILD_PRESET=cloudflare-pages`.
2. Deploy A, run the deployed full-stack verifier (`pnpm test:full-stack-registry-deployed-cloudflare` shape),
   deploy B to the same project and re-verify, then roll back by redeploying A's retained artifact.
3. During the switch, request the page repeatedly from a browser holding the old entry script to observe real
   edge cache skew, which this local run only simulates.

Required and not yet written: a deployed A/B runner (the current one deploys a single candidate), and an
authorisation record. No such deployment happened for this report.

## Limitations

- Local workerd only; the edge is a local proxy, not Cloudflare's cache. Cache headers are set `no-store`.
- One synthetic app and one pair that differs by three files; a pair with a bigger delta (for example
  0.14.0) needs its own run.
- Recovery is optional and a reload can lose unsaved application state; this run left its default untouched.
- Unexpected Angular SSR errors returning HTTP 200 remain an independently documented blocker.
- The historical unexplained Cloudflare concurrency anomaly remains open.
