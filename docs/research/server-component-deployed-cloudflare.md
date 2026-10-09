# Published Server Components on Cloudflare Pages: deployed qualification

Date: 2026-10-09. Baseline: `main` at `40b5d789` (PR #57 merged).
Question: does the PUBLISHED `@strata-sc/server-components@0.1.0` work in a fresh external Analog app built
for Cloudflare Pages and served from a real deployment?

Command: `pnpm test:server-components:deployed-cloudflare`. Runner `tools/server-components/deployed-cloudflare.ts`,
verifier `tools/server-components/lib/deployed.ts` (reuses `lib/browser.ts`, `lib/leak-scan.ts`,
`lib/module-graph.ts`, `lib/package-consumer.ts`). Consumer template:
`tests/server-component-package-consumer/fixture/` (unchanged). Manual workflow:
`.github/workflows/server-component-deployed-cloudflare.yml`.

## Verdict

| Part                                                     | Result                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| LOCAL BUILD QUALIFICATION (below)                        | **GO**                                                     |
| LOCAL WORKERD REHEARSAL of the verifier (not deployment) | PASS                                                       |
| **REAL DEPLOYMENT QUALIFICATION**                        | **NOT RUN** (no Cloudflare credentials available; see end) |
| Overall deployed qualification                           | **CONDITIONAL**: nothing below claims a deployed GO        |

## LOCAL BUILD QUALIFICATION

Measured on this machine, Node v22.23.1, 2026-10-09.

- Package: `@strata-sc/server-components@0.1.0`, `dist.integrity`
  `sha512-ZdCw/Bkm0+vBlSUDfHOEPxthSX9JkcA99fcJGp3tlTtJvmBjrcMf82etLnAlG6kTRD0FOxFPx/wCgNcazg4eXQ==`,
  from `https://registry.npmjs.org`.
- Dependency resolution: the consumer is copied to an OS temp directory outside the repository; the
  dependency is the bare exact string `0.1.0` (no `workspace:`, `link:`, `file:`, tarball or range); plain
  `npm install` with an empty user/global npmrc. Checks: installed `package.json` version is `0.1.0`; a real
  directory (not a symlink) under `consumer/node_modules`; `.`, `/vite` and `/server-only` resolve under
  `consumer/node_modules`, never the repository.
- Versions: Angular 22.1.7, `@analogjs/platform` 2.7.2, Nitro 2.13.4 (from `nitro.json`), Vite 8.3.0,
  Wrangler 4.135.0, TypeScript 6.0.3.
- Cloudflare configuration: `BUILD_PRESET=cloudflare-pages vite build` (Analog's documented path); Nitro
  resolved preset `cloudflare-pages`; compatibility date `2026-09-21` (the website's); **no compatibility
  flags** (`nodejs_compat` deliberately not enabled; the Worker graph needs none). Output directory
  `dist/analog/public`, Worker entry `dist/analog/public/_worker.js/index.js`.
- Worker graph (reachable from the entry): 7 modules, no import outside itself, no Node built-in.
  Browser graph: 18 files (Vite client build plus public assets, minus `_worker.js/`).

| Surface       | Server component impl | Server-only repository | Transitive helper | Client island |
| ------------- | --------------------- | ---------------------- | ----------------- | ------------- |
| Worker graph  | present               | present                | present           | n/a           |
| Browser graph | absent                | absent                 | absent            | present       |

Positive controls: non-empty graphs, each server marker found in the Worker graph, the client marker found in
the browser JS, browser source maps exist and list the client island's source. Browser source maps list no
consumer server file (the generated surrogate shares the Server Component's file name and is the expected
browser stand-in, same rule as the packed-package gate). The scanner itself is controlled: it finds raw,
base64 and hex forms of each marker and does not flag the public client marker.

## LOCAL WORKERD REHEARSAL (not a deployment)

The identical black-box verifier run against `wrangler pages dev` on the same build. It proves the verifier;
it says nothing about a public deployment, and the runner labels it that way. All checks passed:
HTTP 200 `text/html` on `/product` with `<h1>Product 42</h1>`, the server message and the server-computed
evidence; `data-strata-protocol="1"` with an `ngh` annotation and exactly one boundary; hydration with SSR DOM
identity, one hydrated island, no `ngh` left, `Count: 0` then one click `Count: 1`, no console error or
warning; document navigation `/product` → `/about` (new JS realm) → `/product`, reload, direct `GET /about`;
no server marker or server source name in the HTML, response headers (no `x-powered-by`), loaded scripts,
served assets and source maps, or `/_worker.js/index.js`; the `data-strata-props` payload carries only the
public props. Angular Router navigation is a known limitation and is not tested.

Concurrency smoke, local workerd, 40 requests, `GET /product?request=<synthetic id>` (final gate run):

| Round               | Requests | OK  | Failed | Statuses     | p50 ms | p90 ms | max ms |
| ------------------- | -------- | --- | ------ | ------------ | ------ | ------ | ------ |
| sequential baseline | 5        | 5   | 0      | `{"200":5}`  | 9.6    | 12.4   | 12.4   |
| 10 concurrent       | 10       | 10  | 0      | `{"200":10}` | 29.8   | 30.2   | 30.7   |
| 25 concurrent       | 25       | 25  | 0      | `{"200":25}` | 45.3   | 47.5   | 47.5   |

Every body was byte-identical to the baseline and none echoed any issued request id. The page ignores the
query string, so this shows no data from another request appeared; it is **not** a tenant-isolation test.
These are localhost timings of a local runtime: not Cloudflare numbers, no SLA.

## REAL DEPLOYMENT QUALIFICATION

**NOT RUN.**

- Project: `strata-sc-qualification` (the runner refuses any other name, `strata-www` included).
- Deployment identifier, deployed URL, HTTP/browser/confidentiality/concurrency results, first-request and
  warm timings: none. No value is reported because none was measured.
- Why: the local Wrangler login is expired and non-interactive, and no `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` was in the environment. The repository secrets of the same names (used by
  `deploy-www` in `ci.yml`) are only available to GitHub Actions, and a `workflow_dispatch` workflow can be
  dispatched only once it exists on the default branch.
- Missing prerequisite: merge this PR, then run **Actions → Qualify Server Components on Cloudflare**
  (optional `version`, default 0.1.0). It deploys to `strata-sc-qualification`
  (`wrangler pages deploy`, branch `qualification-<version>`, compatibility date 2026-09-21, no flags),
  polls the public `https://<hash>.strata-sc-qualification.pages.dev` until `/product` answers, runs the
  verifier against it, and fails the job if credentials are missing or any check fails
  (`STRATA_SC_REQUIRE_DEPLOYED=1`). The job summary and the uploaded JSON artifact carry the project,
  deployment id (the hash subdomain Wrangler prints), URL, version and verdicts.
- Alternatively, with credentials locally: `STRATA_SC_DEPLOY=1 CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
pnpm test:server-components:deployed-cloudflare`, or verify an existing deployment with
  `STRATA_SC_DEPLOYED_URL=https://…`.

Timing semantics once it runs: the "first observed request" is the first poll after the deploy and is
recorded with its status and latency; it is not labelled a Cloudflare cold start, because Cloudflare exposes
no such signal in the response. Warm and concurrent figures are separate rounds. CPU time and memory are not
exposed and are not reported.

## Failures and limitations

- No defect in the published package was found; nothing was republished and no Changeset was added.
- The deploy path of the runner (`wrangler pages project create` / `deploy`, URL parsing, the effective
  compatibility date for a direct-upload Pages project) is **untested against Cloudflare**. The verifier
  half was exercised on local workerd, and against a deliberately leaking/broken local server it fails.
- The external fixture covers Server Components only; it has no controllers, bindings or request context.
  Authorization, tenant isolation, cancellation and cleanup, resource budgets, rollback and 1.0 readiness
  are not addressed. Angular Router navigation remains NO-GO. Source maps are generated as `hidden` by the
  fixture and are served as static files when deployed; the verifier fetches and scans them.
- Playwright and HTTP checks run from one client location; the concurrency smoke is 40 requests.
