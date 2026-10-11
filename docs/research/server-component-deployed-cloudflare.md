# Published Server Components on Cloudflare Pages: deployed qualification

Date: 2026-10-09 (updated 2026-10-11). Original baseline: `main` at `40b5d789` (PR #57 merged). Latest run: current `main` at `2b50798f` (PR #60 merged).
Question: does the PUBLISHED `@strata-sc/server-components@0.1.0` work in a fresh external Analog app built
for Cloudflare Pages and served from a real deployment?

Command: `pnpm test:server-components:deployed-cloudflare`. Runner `tools/server-components/deployed-cloudflare.ts`,
verifier `tools/server-components/lib/deployed.ts` (reuses `lib/browser.ts`, `lib/leak-scan.ts`,
`lib/module-graph.ts`, `lib/package-consumer.ts`). Consumer template:
`tests/server-component-package-consumer/fixture/` (unchanged). Manual workflow:
`.github/workflows/server-component-deployed-cloudflare.yml`.

## Verdict

Updated 2026-10-11 (baseline `main` at `2b50798f`, PR #60 merged; fourth deployment recorded).

| Part                                                     | Result                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| LOCAL BUILD QUALIFICATION (below)                        | **GO**                                                                            |
| LOCAL WORKERD REHEARSAL of the verifier (not deployment) | PASS                                                                              |
| **DEPLOYMENT EXECUTED**                                  | **YES**: four real deployments to `strata-sc-qualification`                       |
| **DEPLOYMENT FULLY QUALIFIED**                           | **NO**: no GitHub Actions run has passed the whole verifier (see the table below) |
| Remote qualification from a workstation                  | PASS (second and third deployment; run by hand, not by the workflow)              |
| Overall deployed qualification                           | **CONDITIONAL / NO-GO** until the workflow passes from a GitHub runner            |

"Executed" means `wrangler pages deploy` succeeded and a public URL exists. "Fully qualified" means HTTP, SSR,
protocol, Chromium hydration, DOM reuse, interaction, navigation, confidentiality and the concurrency smoke all
passed against that URL in the workflow. Only the first is true.

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

**DEPLOYMENT EXECUTED; NOT FULLY QUALIFIED.** Project `strata-sc-qualification` (the runner refuses any other
name, `strata-www` included), `wrangler pages deploy`, branch `qualification-0.1.0`, Nitro `cloudflare-pages`,
compatibility date `2026-09-21`, no flags, package `@strata-sc/server-components@0.1.0` from registry.npmjs.org.
Credentials are the repository's existing Actions secrets; nothing else (DNS, routes, bindings, dist-tags,
`strata-www`) was touched.

| Run (`workflow_dispatch`, `main`)                                            | Deployment URL                                       | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [38055222217](https://github.com/Andersseen/Strata/actions/runs/38055222217) | `https://<hash>.strata-sc-qualification.pages.dev`   | Deployment succeeded. Readiness failed: `/product` did not answer 200 `text/html` within the bounded window. HTTP/browser checks not reached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [38055684868](https://github.com/Andersseen/Strata/actions/runs/38055684868) | `https://26fdc388.strata-sc-qualification.pages.dev` | Deployment succeeded. Ready on attempt 2 (2405.7 ms). Direct load, SSR (`Product 42`, server message, evidence fingerprints) and protocol v1 PASSED. Chromium then timed out after 30 s on `add-to-cart output`. The same deployment passed the full verifier from a workstation. This run predates the PR #59 diagnostic, so what Chromium received was not captured.                                                                                                                                                                                                                                                                                                                                                                                |
| [38133853890](https://github.com/Andersseen/Strata/actions/runs/38133853890) | `https://cffaf6cc.strata-sc-qualification.pages.dev` | Deployment succeeded. Ready on attempt 1 (580 ms). **30 ms later** the direct `GET /product` returned **404 `text/html`**: HTTP/SSR/protocol checks FAILED (4 + 2). Chromium hydration, DOM reuse, interaction and "no console error" PASSED on the same URL. The navigation check then failed: `click #to-product` timed out (`element is not stable`, then `detached from the DOM`). Confidentiality and concurrency were not reached. 8 failing checks.                                                                                                                                                                                                                                                                                            |
| [38137809896](https://github.com/Andersseen/Strata/actions/runs/38137809896) | `https://af850827.strata-sc-qualification.pages.dev` | First run on `main` after PR #60 (SHA `2b50798f`, 2026-10-11 12:03 UTC, package 0.1.0). Deployment succeeded. Node readiness passed: 5 consecutive 200 `text/html` answers with `<h1>Product 42</h1>` on attempt 5 (8358.9 ms, 0 not-ready). Direct load, SSR (`Product 42`, `External server A`, fingerprints) and protocol v1 PASSED. **0.7 s later** Chromium's document response for the same URL was **404 `text/html`, `server: cloudflare`, cf-ray `a48dbb82e838080d-LAX`, title "Deployment Not Found"** (screenshot: Cloudflare's "Nothing is here yet" page); no failed request, a single navigation. Hydration therefore failed (no `add-to-cart output`). Navigation, confidentiality and concurrency were not reached. 2 failing checks. |

PR #59 added the browser failure diagnostic (requested and final URL, status, content type, title, a 600-char HTML
excerpt, console and page errors). It changed no runtime behaviour. Run 3 is the first run that had it; the
failure moved, so the diagnostic did not fire (the `add-to-cart output` wait succeeded), and the navigation step
that failed had no diagnostic.

Evidence gathered after run 3 (same deployment):

- Verifier from a workstation against `cffaf6cc`: every check PASSED, including confidentiality and the 40-request
  concurrency smoke. `curl` from Madrid: 20 of 20 `/product` and `/about` requests were 200 `text/html`.
- Run 3 therefore saw, from the runner only, 200 then 404 for the same URL within 30 ms, and a document that
  Chromium could load but whose link click never became actionable. Both are consistent with answers that differ
  between requests or edges, and with a slow or re-rendering page on a constrained runner. Neither is proven.
- Side finding: an unrouted path on this fixture (for example `/nope-404`) is **HTTP 200** with an empty SSR shell
  (`<app-root><router-outlet></router-outlet></app-root>`). A readiness probe that checks the status alone cannot
  tell a ready route from that shell. This is Analog fixture behaviour, not a package defect.

**Root cause: UNRESOLVED.** Hypotheses not excluded: (B) uneven edge readiness for a fresh deployment from the
runner's location; (C) a transient 404; (D) network or DNS differences; (E/F) navigation timing on a loaded
runner. A CDN challenge is not supported (the 404 and the 200s were `text/html` from the application or Pages, and
Chromium rendered the real page in run 3), a real application defect is not supported (the same artifact passes
from a workstation), and no evidence implicates the published package. Nothing was republished.

Corrective change (PR `fix/server-components-cloudflare-runner`), limited to what the evidence supports:

- Readiness is now 5 consecutive 200 `text/html` answers that contain the server-rendered `<h1>Product 42</h1>`,
  within 40 attempts 2 s apart. A miss resets the streak. Every answer that was not ready is recorded (attempt,
  status, `server`/`cf-ray`/`cf-cache-status`/`age`/`content-type`/`content-length`/`location`/`cache-control`)
  and is printed on failure and in the evidence JSON (`firstRequest.notReady`). A status-only 200 is no longer
  enough.
- The direct-load check prints the edge headers and the first 160 body characters when it fails.
- Both Chromium checks (hydration, navigation) record every document response with its edge headers, failed
  requests and main-frame navigations, print them in the error, and, on failure only, write a screenshot and a
  Playwright trace; the workflow uploads them as `deployed-cloudflare-browser-diagnostics` (failure only). The
  site is public and the browser sends no credentials, so neither can contain a secret.
- No assertion was removed or weakened: raw SSR, protocol v1, hydration, DOM identity, interaction, navigation,
  confidentiality and concurrency are unchanged.

The workflow cannot be run for a pull request without exposing the Cloudflare secrets to its code, so this change
is **not** production-qualified. It must be merged, then **Actions → Qualify Server Components on Cloudflare**
re-run from `main`. If that still fails, the new artifact shows what Chromium and Node received. Until it
passes, the status above stays CONDITIONAL / NO-GO.

### Run 4 (38137809896): what the diagnostics established

Established by the artifact and the log (not hypotheses):

- The Chromium document was **not the application**. It was Cloudflare's own "Deployment Not Found" page
  (`server: cloudflare`, no application headers), served for the correct URL (`finalUrl` equals `requested`, no
  redirect, no failed request). So the 404 is not an application route, a navigation race or a page replacement.
- Node's five consecutive good answers (the last at 12:05:20.12) and Chromium's 404 (12:05:20.83) are 0.7 s apart
  and came from the same runner. The Node answers and the Chromium answer are therefore not interchangeable
  evidence of readiness: a Node probe passing did not guarantee what the next client was served.
- This matches run 3 (200 then 404 within 30 ms) and is the same family as run 1. Together the runner has now seen
  Cloudflare's "not ready" answer for a deployment whose URL had already answered 200.

NOT established: why the answers differ. Candidates that remain open are uneven edge propagation of a fresh
deployment (the Node probe may reuse one keep-alive connection while Chromium opens a new one, possibly to a
different anycast address or edge), and runner-network effects. The workstation passes against the same
deployments. No evidence implicates the published package or the application.

Corrective change (branch `fix/server-components-cloudflare-qualification`), a harness change only: after the
Node readiness gate, the runner now requires 3 consecutive loads of `/product` in **fresh Chromium contexts** that
return 200 `text/html` with `<h1>Product 42</h1>` in the document response (`awaitBrowserReady`, bounded to 40
attempts 2 s apart; every miss recorded with edge headers in `deployed.browserReady.notReady`). The observable is
the same as the Node gate, applied through the client the later checks use. Locally, against deployment
`af850827` it passes on 3 attempts with no misses, and against an unrouted path (HTTP 200 empty shell) it
correctly never becomes ready. No assertion was removed or weakened, no timeout of a later check was raised.

Limitation: this does not prove the Cloudflare behaviour is benign. It only stops the harness from starting the
browser checks before the browser can be served the app. It cannot be verified for a pull request (secrets), so
it is **unverified until merged and the workflow is re-run from `main`**. If a later run fails on the new gate,
`browserReady.notReady` will show how long, and from which edge, Chromium was served the not-ready page, which
would be evidence of a Cloudflare propagation delay rather than a harness defect.

Timing semantics: the "first observed request" is the first poll after the deploy and is recorded with its
status and latency; it is not labelled a Cloudflare cold start, because Cloudflare exposes no such signal.
Warm and concurrent figures are separate rounds. CPU time and memory are not exposed and are not reported.

## Failures and limitations

- No defect in the published package was found; nothing was republished and no Changeset was added.
- The deploy path of the runner (`wrangler pages project create` / `deploy`, URL parsing) now works against
  Cloudflare (four deployments). The verifier is not yet green from a GitHub runner; see above.
- The external fixture covers Server Components only; it has no controllers, bindings or request context.
  Authorization, tenant isolation, cancellation and cleanup, resource budgets, rollback and 1.0 readiness
  are not addressed. Angular Router navigation remains NO-GO. Source maps are generated as `hidden` by the
  fixture and are served as static files when deployed; the verifier fetches and scans them.
- Playwright and HTTP checks run from one client location; the concurrency smoke is 40 requests.
