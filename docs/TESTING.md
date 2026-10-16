# Testing strategy and evidence

Tests should prove observable contracts and failure boundaries. The existing suite is summarized in
[STATE](STATE.md). The M1 packed-consumer tooling now exists and has executed; later milestone
requirements below remain future evidence.

## Progressive gates

| Gate | Required tests                                                                                                                                   | Evidence retained                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| M1   | Existing units/in-process H3 tests plus packed consumer types, compilation and execution                                                         | Exact tuple, tarball manifests/digests, commands, outputs and raw Vite characterization                            |
| M2   | Minimal Angular/Analog runtime mounting, DI concurrency/disposal, AOT and strict graph PoC; SSR plus one hydrated child; Workers smoke           | Pinned fixture, source/hook trace, build graphs and a go/no-go report                                              |
| M3   | Core semantics; H3 adapter integration; verbs/input validation/errors/guards/interceptors; Angular providers and Analog SSR/serverFn coexistence | Contract tests through public APIs, failure/abort cases, Node/Workers results                                      |
| M4   | SSR, hydration, incremental hydration/@defer, navigation, serialization, graph assertions and negative leaks                                     | Production browser/e2e reports, client/server graph artifacts and negative-test diagnostics                        |
| M5   | Node/Cloudflare deployment, package publication, load/cleanup, compatibility matrix and real application e2e                                     | Candidate digest, deployment records, runtime versions/config, consumer revision, operational and rollback results |

## Current M1 evidence and next checks

`pnpm test:consumer` builds/packs both packages and installs an external consumer. SPEC-001 proves
its metadata and real H3 behavior through both emitted-JS and Vite reference outputs; direct Vite
fails at Node parsing. The strict typecheck remains a required failing gate, not an expected-failure
success. See [original evidence](research/consumer-compilation.md).

[SPEC-002](specs/002-h3-consumer-type-closure.md) defines the next exact type-closure controls and
promotion criteria. A clean typecheck and runtime proof must come from the same allowed candidate;
`noEmitOnError: true` prevents a failing candidate from being promoted on emitted output alone.
Diagnostic matrix success or installation of all platform type packages is not compatibility proof.

Use actual consumer-local H3/TS/Vite/Rolldown resolution, effective options, diagnostic origins and
fresh outputs. SPEC-001's runner reported workspace Rolldown while the consumer resolved a different
patch. Preserve the historical report and write new evidence separately. Classify unknown compiler
errors and installation failures without assigning hard-coded upstream blame.

The merge CI stopped at lint before building core's exported declarations; consumer qualification
was skipped. Build prerequisites before type-aware lint on a fresh checkout, retain all gates, and
link the remote result. Local lint with preexisting `dist` does not prove that bootstrap path.

## CI layout

`ci.yml` runs five parallel jobs behind one aggregate `Verify` check (branch protection and `deploy-www` depend
on that name): `static` (lint, typecheck, unit tests), `graph` (graph, navigation, defer, server-only, dev server),
`runtime` (confidentiality, request context, failures, SSR response, authorization on Node + workerd),
`consumers` (packed-package consumers, Cloudflare rehearsal, TypeScript 5.9) and `apps` (website and Relay).
Each job builds the packages itself through `.github/actions/setup`, so wall time is the slowest group, not the sum.
`extended.yml` holds what must not slow or gate pull requests, weekly (Monday 04:00 UTC) and on demand: the
performance baseline, the published-package Cloudflare rehearsal and the H3 type-closure experiment.

## Full-stack performance baseline

`pnpm test:full-stack-performance` (`tools/performance/full-stack.ts`) is an explicit measurement command, not
a CI gate: it builds four arms of one application from the packed tarballs outside the workspace, asserts
correctness strictly (tuple identity, packed-package identity, build/confidentiality marker matrix, API/SSR
contract, hydration smoke, six live negative controls) and records sizes and latencies **without any
performance threshold**. Its deterministic self-tests (compression, file classification, reachable-graph
totals, deltas, formatting, missing metrics and zero baselines, report completeness, invalid-response exclusion,
tuple mismatch, contaminated baseline, broken variants) run in normal CI as `pnpm test:performance-tools`
(part of `pnpm test`). `.github/workflows/extended.yml` runs it weekly and on demand (`workflow_dispatch`, with custom repetitions,
requests, warm-up and concurrency) on a GitHub-hosted runner: no deployment, publication or secrets, JSON uploaded. See the
[report](research/full-stack-performance-baseline.md).

`STRATA_PERF_ISLANDS=1|3` (default 1) selects the island profile; the same four arms are built with one or with three distinct interactive
islands and the three-island profile adds a multi-island hydration/interaction smoke (original nodes reused, one request and one state update per
click, no cross-island effect), boundary-identity and canary checks, and five more negative controls. `pnpm test:full-stack-performance:compare
<one report> <three report>` renders the scaling tables and refuses an incomparable pair (package versions, dependency tuple, Node/wrangler,
compression, presets, arm definitions, an incomplete report or a failed arm); it applies no threshold. The manual workflow takes `islands:
one | three | both`; `both` runs the two profiles in one job on one runner and uploads both reports, the comparison and a redacted environment file.
Self-tests grew from 94 to 163 (`pnpm test:performance-tools`). See the [scaling report](research/full-stack-performance-scaling.md).

## Current Server Component evidence

The experimental `@strata-sc/server-components` package has unit tests for its isolable logic
(template boundary discovery, rejected module shapes, surrogate content, runtime import purity).
They do not replace the production-build runners, which remain the authority for graphs and
hydration:

- `pnpm test:server-components`: a plugin-off control build that must leak every server canary,
  then the split build. Browser output must lack the implementation, repository, transitive and
  server-only-import canaries, `@angular/compiler`, the TypeScript compiler, the Vite transform and
  Node built-ins; the server output must contain them. Then HTTP SSR and Chromium hydration by DOM
  node identity, one island, one increment per click.
- `pnpm test:server-component-navigation`: direct SSR, document navigation, the fixture's
  consumer-owned Router document fallback (RouterLink and `navigateByUrl`), Back/Forward,
  query/fragment preservation, the isolated Angular Router empty-surrogate control (pinned as
  the recorded NO-GO), and island teardown through fixture-owned probes.
- `pnpm test:server-components:cloudflare`: the same contract, including the document fallback,
  on local workerd via Wrangler.
- `pnpm test:server-component-ssr-response`: the consumer-owned expected-service recovery contract
  on Nitro node-server and local Wrangler/workerd. It checks 200 success, 503/no-store generic
  recovery, 400 invalid-context fallback, response/body confidentiality, overlap isolation and
  document navigation/Back/re-entry. Constructor, injected-service and template render failures
  remain explicit HTTP 200 controls; this gate does not claim a general Angular render-error
  status bridge, streaming, or SPA subtree navigation.
- `pnpm test:server-component-authorization`: fixture-only request-bound authorization for two
  synthetic tenants. It uses one opaque HttpOnly cookie as the trusted principal, rejects missing,
  invalid and duplicate credentials, ignores route/query/header identity overrides, proves the
  repository is called only after ownership authorization, checks 200/401/403/404 no-store
  responses, mixed 24-request overlap, browser cookie confidentiality and document navigation on
  Nitro node-server and local workerd. It does not qualify production authentication or tenant-aware
  caching.
- `pnpm test:server-component-dev`: the real Analog/Vite **dev** server and Chromium. Edits the
  fixture's `server-component-dev/*` files while `vite` runs (every byte restored) and proves: a
  server-owned edit regenerates the graph and replaces the JS realm with one document reload; a
  client island edit is not reloaded by Strata; a module that starts asserting server-only is
  refused live (import, `import()`, `?raw`, `?url`) with no canary in any response; invalid edits
  fail the client graph closed with the analyzer's diagnostic and recover when fixed.

- `pnpm test:server-component-package-consumer`: builds and `pnpm pack`s the private package, installs
  the tarball with `npm` into a real Analog app copied to an OS temp directory outside the workspace
  (`tests/server-component-package-consumer/fixture`), and proves tarball layout, export targets,
  dependency/peer closure, declarations under TypeScript 6.0.3 and 5.9.2, a Node production build
  (graph split, hidden source maps, SSR, protocol v1, hydration, document navigation), the server-only
  firewall (direct, dynamic, `?raw`) from the installed plugin, `vite` dev with one server-owned edit and
  a Cloudflare build on local workerd. Nothing is published; the package stays private.

- `pnpm test:full-stack-package-consumer`: packs `@strata-sc/core`, `@strata-sc/analog` and
  `@strata-sc/server-components`, installs the three tarballs with `npm` into one Analog app outside the
  workspace (`tests/full-stack-package-consumer/fixture`) and proves tarball/lock/single-core identity,
  declarations (TypeScript 6.0.3 and 5.9.2, `skipLibCheck: false`), a Strata controller API
  (routing, 404, request-scoped lifecycle, native route), a server-only `@ServerComponent()`, a hydrated
  island calling the API (one click, one request, one update), document navigation with
  `strataDocumentNavigationGuard`, graph/canary scans and the server-only firewall on Node and local
  workerd. It does not share Angular DI with the controller and is not production adoption.

- `pnpm test:full-stack-deployed-cloudflare`: the same external consumer built from the source-packed
  tarballs for Cloudflare Pages (preset, Worker/browser graph, canary scans, build-time firewall), then the
  URL-agnostic black-box verifier (controller API, SSR, hydrated island, document navigation and the
  navigation guard, public-surface confidentiality, 5/10/25 request smoke) against local workerd. This
  PR-safe rehearsal is NOT a deployment and prints `REAL DEPLOYMENT: NOT RUN`. The same command with
  `STRATA_FULLSTACK_DEPLOY=1` and the Cloudflare secrets is run only by the manually dispatched workflow
  `full-stack-deployed-cloudflare.yml` against the isolated `strata-fullstack-qualification` project
  (`STRATA_FULLSTACK_REQUIRE_DEPLOYED=1` fails anything but a GO deployment). Two dispatches so far, both
  NO-GO (see the deployment record). A third dispatch of the corrective branch passed
  ([run 38741663534](https://github.com/Andersseen/Strata/actions/runs/38741663534)). See
  [the report](research/full-stack-deployed-cloudflare.md).
- `pnpm test:full-stack-cloudflare-concurrency` is a read-only, bounded (at most 1500 requests per URL)
  controller concurrency diagnostic with correlation ids, response classification and fault-injection
  negative controls; set `STRATA_FULLSTACK_DEPLOYED_URL` to include an existing isolated-project deployment.
  It is not a release verdict. See [the report](research/full-stack-cloudflare-concurrency.md).

These cover one code shape. Items 5 and 6 of the strict bundle proof below (forbidden-import
fixtures with import-chain diagnostics, renamed/barrel/dynamic imports) are still open.

## HTTP and DI

Unit tests establish path normalization, metadata ownership/immutability, allowed method shapes and
input/validation behavior. H3 integration must exercise actual HTTP semantics: method/path matching,
params, status/headers, repeated cookies, `Response`, supported streams, errors and cancellation.
Test native H3 routes beside controllers and document collision behavior.

Use overlapping authenticated requests to expose accidental instance/global reuse. Verify request
services and provider disposal under success, validation/auth rejection, thrown/rejected handler,
aborted request and navigation cancellation. Identity checks must cover controller/SSR/serverFn
paths if a shared request is promised. Test injectors with provider overrides; mocks alone do not
qualify an Analog integration.

## Strict bundle proof

Every supported production build must generate an auditable browser/server module inventory. The
compiler must reject illegal browser-to-server imports before optimization; byte scanning alone
can miss renamed/minified code. Combine graph provenance with artifact inspection:

1. A server component depends on a marked service and an ORM-like transitive test module. Give each
   synthetic canaries and actually exercise the dependency in SSR so tree shaking cannot make an
   unused example pass. Use fake secrets, never production credentials.
2. Confirm the server graph includes the implementation and dependencies and its response reflects
   their execution. Confirm the browser graph excludes all three transitively, including renamed
   modules, shared barrels, dynamic imports and lazy chunks.
3. Inspect every emitted browser asset, publicly served source map, manifest and preload reference;
   inspect initial HTML, transfer state, component props/payloads and error responses for private
   canaries. Server artifacts must not be served under public asset URLs.
4. Confirm the interactive child exists in the client graph and responds to user input after
   hydration. Assert server-created DOM is reused and listeners run once, not merely that CSR
   recreated a clickable button.
5. Add deliberately forbidden direct, transitive, re-exported and dynamic imports to a browser
   entry. Each fixture must fail with a useful import-chain diagnostic. Test type-only imports
   separately; erased references must not be mistaken for runtime leaks.
6. Run a positive-control fixture that deliberately exposes a canary and confirm the leak detector
   fails. Missing inventories/output must fail the assertion, not produce an empty passing scan.

Run minified production builds as well as development checks. Repeat graph assertions after
framework/compiler upgrades and against the installed/published package path. Passing one code
shape is insufficient; nested components, aliases, barrel exports and code splitting need coverage.

## SSR, browser and navigation

Test a direct initial request with meaningful server HTML and no browser execution, then hydration
with interactive children, including an event before a deferred boundary hydrates. Cover ordinary
hydration, incremental triggers, nested `@defer`, nested boundaries and conventional Angular siblings.
Watch for console hydration errors, duplicated handlers and cross-request state.

For the chosen navigation strategy test links and programmatic transitions, deep links, forward/back,
query/parameter changes, redirects, abort/races, slow/failing responses, stale deployment IDs,
refresh, mixed CSR/server-component routes, focus and scroll. Document navigation must prove that
all server-component transitions obtain a new document. A payload strategy must prove cleanup,
authorization and a supported Angular attach/hydrate lifecycle. Test unsupported combinations fail
clearly rather than fetching server implementations.

Serialization tests enumerate accepted values and rejected functions/services/cycles, hostile HTML
strings, oversized input, missing boundary IDs and cross-version payloads. Security tests must cover
authorization on direct endpoints, cache partitioning, error redaction and origin/CSRF handling for
any state-changing operation. Server code exclusion does not make returned data automatically safe.

## Deployment, consumer and performance evidence

Local workerd tests cannot replace an actual Cloudflare deployment. Qualify the complete Analog
SSR/controller/component path on the selected Cloudflare shape and Node output. Capture exact
compatibility flags/date, bindings, build/preset versions and artifact digest; synthetic secrets
must remain unavailable to browser assets and responses. Exercise cold start, concurrent users,
cancellation and safe failures in the deployed runtime.

Pack/install checks must avoid workspace aliases. At RC, repeat against the published candidate:
types/exports, dependency ranges, README example, build output, source maps and registry contents.
An npm dry run does not prove installation works.

Compare native Analog, Strata controllers and Strata components on the same fixture and machine or
deployment class. Record JS bytes (raw/compressed), SSR response latency, memory, build overhead and
cold start. Agree justified regression budgets from measurements before M5; avoid arbitrary scores.

Only after controlled fixtures pass, run equivalent e2e and graph checks in ForgeCMS or the selected
real app. Record app/Strata revisions, deployment path, real use, observed objectives and rollback.
The consumer is evidence; its domain model must not become a Strata dependency.

## Evidence format

Each spec/report records baseline commit, exact versions/lockfile, commands, expected/actual result,
test names, artifact locations and limitations. A release record links CI runs and deployment
results for one candidate. Mark unavailable checks as **not run**, never passed. Required remote
checks can run in CI later but keep their gate open until their result exists.

The request-context isolation fixture additionally uses two distinct synthetic
private canaries and an identity allow-list. Its gate must prove parent, nested
child and server-only repository agreement across 24 overlapping requests in
both orders, fresh sequential contexts, invalid identity inputs, repository
failure/recovery, Node and local workerd. A rejected fixture identity must render
only the empty safe state; it must never select another actor's data.
