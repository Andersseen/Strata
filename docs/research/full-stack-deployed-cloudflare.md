# Full-stack Strata on Cloudflare Pages: deployed qualification

Date: 2026-10-15  
Baseline: `32a174707b356c300ce91dae51eedf92cf45f043` (`main` after PRs #79 and #80)  
Branch: `test/full-stack-deployed-cloudflare`

## Verdict first

This increment adds the **machinery** to qualify the complete full-stack path on a real Cloudflare Pages
deployment, and runs everything that can run without deploying. **The real public deployment has not been
executed. REAL DEPLOYMENT: NOT RUN.** No deployed verdict is claimed.

| Verdict                                      | Result                           |
| -------------------------------------------- | -------------------------------- |
| External source-packed consumer              | GO (local, this checkout)        |
| Full-stack Cloudflare build                  | GO (local)                       |
| Local workerd rehearsal                      | GO (local; **not** a deployment) |
| Real public Cloudflare deployment            | **NOT RUN**                      |
| Deployed controller integration              | NOT RUN                          |
| Deployed Server Component SSR                | NOT RUN                          |
| Deployed interactive island                  | NOT RUN                          |
| Deployed confidentiality                     | NOT RUN                          |
| Real application production adoption         | NOT QUALIFIED                    |
| Production authentication and tenant caching | NOT QUALIFIED                    |
| Shared controller/SSR Angular DI             | NOT QUALIFIED                    |
| True SPA Server Component navigation         | UNSUPPORTED                      |
| Streaming SSR                                | UNSUPPORTED                      |
| Strata 1.0                                   | NOT YET QUALIFIED                |

Only a successful, explicitly dispatched run of the workflow below can move the "Real public Cloudflare
deployment" row (and the four deployed rows) to GO. Until then they read NOT RUN, whatever the local
rehearsal shows.

## Terms used precisely

| Term                       | Meaning here                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Source-packed artifact     | The three packages `pnpm pack`ed from the checked-out commit. Not a registry release; nothing is published.                     |
| Local Cloudflare build     | `BUILD_PRESET=cloudflare-pages vite build` of the external consumer, plus graph inspection. No network.                         |
| Local workerd rehearsal    | The black-box verifier against `wrangler pages dev`. Proves the verifier and the build run on workerd; **not** the public edge. |
| Real Cloudflare deployment | `wrangler pages deploy` to the isolated Pages project and verification of its public HTTPS URL.                                 |
| Real browser verification  | Playwright Chromium against that public URL (or, in the rehearsal, the local workerd URL).                                      |
| Production adoption        | A real application using the path in production. Not claimed anywhere in this document.                                         |

The evidence JSON carries `candidate: "SOURCE-PACKED CANDIDATE"`. Source-packed deployment evidence is **not**
equivalent to published-registry qualification (compare
[server-component-deployed-cloudflare](server-component-deployed-cloudflare.md), which qualifies the
published `@strata-sc/server-components@0.1.0` for Server Components only; that narrow GO is unchanged).

## What was built

- `pnpm test:full-stack-deployed-cloudflare` (`tools/server-components/full-stack-deployed-cloudflare.ts`).
- `.github/workflows/full-stack-deployed-cloudflare.yml`, "Qualify Full-Stack Strata on Cloudflare":
  `workflow_dispatch` only; project `strata-fullstack-qualification` only; own concurrency group; 30 min
  timeout; `contents: read`.
- The candidate is the **same** external consumer qualified by PR #80
  (`tests/full-stack-package-consumer/fixture`). It is not copied into `apps/www` and no source alias or
  workspace resolution is introduced.
- Shared code, extracted without changing either runner's semantics or commands:
  `lib/full-stack-install.ts` (pack, external `npm install`, tarball/lock/single-copy proofs),
  `lib/full-stack-verify.ts` (HTTP, island and navigation suites, now URL-agnostic),
  `lib/full-stack-remote.ts` (readiness, failure-only browser diagnostics, public-surface scan, concurrency),
  `lib/pages-deploy.ts` (idempotent project create + deploy). `lib/deployed.ts` only gained an optional
  readiness probe that defaults to its previous route and needle; the historical runner is untouched.
- `pnpm test:full-stack-package-consumer` keeps its commands and now also asserts that the island's page
  load produces no failed network request (174 checks, was 172).
- `ci.yml` runs the new command on pull requests as phases 1 and 2 only (no secrets, no deployment).

## The three phases

1. **Local build (always).** Pack core, analog and server-components from the checkout; install only those
   tarballs into the fixture copy outside the workspace; assert real (non-symlink) directories,
   byte-identity with the tarball, lock `resolved` is a `file:` tarball with the tarball's sha512, one
   `@strata-sc/core`, the `analog -> core` dependency, no h3 package, all six entry points resolve under
   `consumer/node_modules`. Run the build-time server-only firewall on the Cloudflare build (an island
   importing the server-only repository must fail the build, naming the importer, printing no private value),
   then build the candidate: Nitro preset `cloudflare-pages`, `_worker.js/index.js` present, public assets
   present, Worker graph with no Node built-in (so no `nodejs_compat`), server markers in the Worker graph,
   zero private canaries in any public asset or source map, controller code only in the Worker, the island
   marker only in the browser.
2. **Local workerd rehearsal (always).** `wrangler pages dev` of the same output, then the full verifier
   (below). It is reported as "Local workerd rehearsal (not a deployment)".
3. **Real public deployment (explicit only).** `STRATA_FULLSTACK_DEPLOY=1` (set by the workflow) deploys the
   already-qualified output; `STRATA_FULLSTACK_DEPLOYED_URL` verifies an existing deployment of the same
   project instead (the host must be `*.strata-fullstack-qualification.pages.dev`). With neither, the
   runner prints `REAL DEPLOYMENT: NOT RUN`. With `STRATA_FULLSTACK_REQUIRE_DEPLOYED=1` anything other than a
   GO deployment fails the run; nothing is skipped silently. Phase 3 does not start when phases 1 or 2 failed.

## The black-box verifier (identical for workerd and the public URL)

- **Readiness**, bounded (40 attempts, 2 s): the page and the controller must each answer correctly 5 times
  in a row over HTTP, and fresh Chromium contexts 3 times in a row (a previous deployment saw Node and
  Chromium disagree briefly). Every not-ready answer is kept in the evidence; a temporary 404 is a readiness
  observation, never a reason to drop an assertion.
- **Controller:** `GET /api/products/42` (200 JSON, expected body, catalog-fingerprint evidence header,
  `no-store`), `/api/products/7`, `/api/products/999` (404 `{"error":"not_found"}`), `/api/native`.
- **Server Component SSR:** `/products/42` title, server-computed tier and `data-evidence` hash of every
  server-only value, protocol-v1 boundary with `ngh`, props exactly `{"productId":"42"}`; `/` and `/about`
  semantic content.
- **Browser:** SSR DOM visible before any script (scripts held), hydration reuses the SSR nodes, exactly one
  island and no leftover `ngh`, one click = one API request = one state update, no console error, no failed
  network request. Document navigation: `/` to product, product to about, Back, Forward, refresh,
  re-entry, and `strataDocumentNavigationGuard` (a Router link becomes one real document request keeping
  query and fragment). No SPA subtree hydration is attempted or claimed.
- **Confidentiality:** the synthetic private values (raw, base64, hex, reversed, percent-encoded) and
  consumer server file names in the SSR HTML, headers, controller JSON, hydration metadata, every script
  reachable from the document (bounded crawl of lazy chunks), every sibling source map, the hydrated DOM,
  network bodies and console; `/_worker.js*` is not served; positive controls prove the repository, the
  controller and the island script actually ran or loaded. Names are logged, never values.
- **Concurrency smoke** (80 requests): 5 sequential, 10 and 25 concurrent for the Server Component documents
  and the controller API. Resources are alternated (`/products/42` vs `/999`; `/api/products/42`, `/7`,
  `/999`) so a response that belongs to another request fails its own baseline; no body may echo a request
  id or leak a canary; p50/p90/p95 are recorded. No budget or SLA is asserted and this is not load
  evidence. The request-scoped lifecycle counters of PR #80 are **not** probed remotely (isolates are reused
  or replaced; the counter endpoint is not something to depend on over a public URL).

## Local results (this checkout; no deployment)

`pnpm test:full-stack-deployed-cloudflare`: 142 checks, 0 failing, about 1 minute.

```text
candidate           SOURCE-PACKED CANDIDATE (checkout 32a174707b356c300ce91dae51eedf92cf45f043)
@strata-sc/core     0.2.1  sha256 5cca820df06f039519a467db1f4c13ca3d56c8e5d582940251f4574f5c1fcb2e
@strata-sc/analog   0.2.1  sha256 74c8d2c69e646e71435c15f1865b45af220527e9d70c51c23181611bdc78610e
@strata-sc/server-components 0.2.0  sha256 3b205f53ebe05e083e583033c0caf52cc4bcadd15e0ec414d86004c6cc8a04ef
Angular 22.1.7, @analogjs/platform 2.7.2 (vite-plugin-nitro 2.8.1), nitropack 2.13.4, h3 1.15.11,
vite 8.3.0, TypeScript 6.0.3, wrangler 4.135.0, Node 22.23.1
preset cloudflare-pages, compatibility date 2026-09-21, flags: none (nodejs_compat NOT enabled)
Worker: 9 reachable modules, 0 externals, 0 Node built-ins; public: 15 assets, 7 source maps
```

Local workerd rehearsal latency (one developer machine, loopback; **not** edge latency, no budget implied):

| Round                           | p50 ms | p90 ms | p95 ms |
| ------------------------------- | -----: | -----: | -----: |
| Server Component, 5 sequential  |    9.7 |    9.8 |    9.8 |
| Server Component, 10 concurrent |   17.6 |   18.6 |   18.9 |
| Server Component, 25 concurrent |   37.1 |   38.6 |   38.6 |
| Controller, 5 sequential        |    2.3 |    2.3 |    2.3 |
| Controller, 10 concurrent       |    4.2 |    5.9 |    6.0 |
| Controller, 25 concurrent       |   14.2 |   15.4 |   15.5 |

Tarball digests are those of the run that produced this note; every real run writes its own into the
evidence JSON, which is authoritative.

## Known limitations observed (recorded, not fixed, not production claims)

- An unmatched `/api/*` path falls through to the Angular HTML document (200 `text/html`).
- An unknown product page renders the not-found branch with HTTP 200 (soft 404).
- Unexpected Angular render errors may still return 200 (not exercised here).
- Controller and Angular SSR injectors are separate; shared DI is not qualified.
- No authentication, authorization, tenant-aware caching or CSRF/mutation actions; no bindings are used, so
  Cloudflare bindings remain unqualified.
- True client-side Server Component subtree navigation and streaming SSR are unsupported.
- The fixture is not a real-world application; a public deployment is not production authentication;
  local workerd is not the public edge.

The runner prints the first two as `known limitation observed:` lines and stores them in the evidence.

## Operator instructions: running the real deployment

Nothing here runs automatically. After this PR is merged (or from the PR branch, deliberately):

1. GitHub, Actions, "Qualify Full-Stack Strata on Cloudflare", "Run workflow" on the chosen ref.
   Requires the existing repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   (the same ones `deploy-www` uses; no new credentials). The token needs Pages edit permission for the
   account; the first run creates the `strata-fullstack-qualification` project if absent.
2. Read the job summary and download the `full-stack-deployed-cloudflare-evidence` artifact
   (starting SHA, package digests, dependency tuple, build digest, deployment hash/ID, URL, run URL,
   readiness attempts, route, browser, concurrency and confidentiality results). A failed run also uploads
   a screenshot and trace of the failing page.
3. Only a green run with `Real public Cloudflare deployment: GO` may be recorded below. Record the URL and run
   URL, keep failed runs (as the historical report does), and update `STATE.md`, `RISKS.md` and
   `RELEASE-1.0.md` from that evidence. A GO would still cover this fixture, not a real application.

## Deployment record

| Field                | Value       |
| -------------------- | ----------- |
| Real deployment      | **NOT RUN** |
| Public URL           | (none)      |
| Actions run          | (none)      |
| Deployment hash / ID | (none)      |

## What this does not change

`strata-sc-qualification` and its workflow are untouched and its historical GO stays narrowly valid.
`strata-www`, DNS, routes, bindings and databases are never touched. No package was published, no dist-tag
moved, no package version or Changeset changed, no production framework API was added.
