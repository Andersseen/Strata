# Technical risk register

Current state (2026-10-27): main `efd14e2d` contains the exact-SHA `workflow_run` release gate for issue #117.
The verifier requires a successful aggregate `Verify` for the same completed main push and rechecks the current
main SHA before Changesets. Hosted workflow runs and pending/failure/cancelled/stale-main transitions could not
be inspected in this pass, so issue #117 stays open. The 0.10.0 Server Components observer reports only Strata's
per-host transaction; it is not Angular health monitoring. Evidence levels and local / packed / hosted / deployed
limits are in the [candidate report](research/server-component-hydration-observability-v010.md).

The 0.10.0 form API also passed Node/dev/local-workerd fixture and
packed-consumer checks, while hosted CI and deployed checks are pending. See
[Analog validated forms](research/analog-validated-forms-v010.md).

Evidence note (2026-10-23, 0.8.0 branch): deployment version skew for Server Components is detected and
classified, not eliminated. With the opt-in `buildId` a document and a script of two real builds are refused
as `build-mismatch` before any island exists (Node and local workerd, packed consumer); scripts built before the
feature, apps that do not opt in, and rollbacks to pre-identity builds remain undetected. The identity is
client-readable markup: a tampered well-formed value can cause at most one bounded reload per tab and window.
Recovery is local evidence only; no deployed Pages run and no CDN-cache behaviour was exercised. See
[the evidence](research/server-component-deployment-skew-v08.md).

Evidence note (2026-10-22, 0.7.0 branch): the intermittent Server Component SSR failure (HTTP 200, empty
island, `JIT compiler unavailable`) has a reproduced mechanism. Analog builds `client` and `ssr` concurrently
with one shared Angular plugin that releases its compilation output at the first environment's `buildEnd`;
files the other environment transforms afterwards are silently skipped and ship uncompiled. A fault-injected
schedule reproduces the exact signature (`ProductPage.get` → `getCompilerFacade`); the plugin now serializes
the environments' `buildEnd` and a post-transform gate fails any build that still contains an uncompiled
source-owned Angular class or an unlinked partial declaration. Residual risk: the failure was never observed
naturally outside CI and the CI failures were not captured with build output, so attribution is by matching
signature, and the gate covers modules that pass through Vite, not packages Nitro traces by itself. The
general limitation remains: an unexpected Angular render error still returns HTTP 200 and Strata has no
supported way to change that. A dev-only bypass of the server-only assertion through Vite 8's dependency optimizer
was reproduced and closed in 0.9 (marked package modules, barrels and dynamic imports are refused; unmarked packages
are still not detected; a warm optimizer cache survives an in-place edit that adds the assertion; a failed first
optimizer run ends `vite` dev, see [the evidence](research/server-component-optimized-dependency-firewall-v09.md)). Separately, issue #117 identified publishing before aggregate CI verification. Main now has the exact-SHA `workflow_run` gate; hosted transition evidence remains open as recorded above.
See [the evidence](research/server-component-ssr-integrity-v07.md).

Evidence note (2026-10-23, Analog 0.7.0 candidate): `streamResponse()` closes the gap between the controller
invocation and the response body for an explicitly owned stream, but it inherits what the pinned transport does.
Nitro 2.13.4 / H3 1.15.11 never tells the response body that the client left, so a streamed body that does not
end holds its request-scoped resources (and, on Node, keeps producing into a closed socket): only finite bodies
are safe. A body that fails after the first chunk leaves a Node connection open with no end, and on the
Cloudflare Pages preset the whole body is buffered and a mid-body failure becomes an empty `200`, so neither
runtime lets a client tell a failed stream from a finished one. Analog 2.7.2 server-function dispatch with POST
needs the H3 v1 `readBody`, but `@analogjs/router` imports an undeclared `h3`: with H3 v2 hoisted it answers
`400 Malformed request body` (declared as a workspace `packageExtensions` entry, as for the Nitro plugin), and on
workerd every server function answers `500` because Angular's JIT is unavailable. Fixture evidence, not
production adoption. See [the evidence](research/analog-stream-lifecycle-v07.md).

Evidence note (2026-10-24, 0.9.0 branch): `validateHeaders` gives schemas the native `Headers` view, so repeated fields arrive
combined with `", "` and per-line fidelity is only available from `request.headers`; a schema that reads `authorization`,
`cookie` or `x-forwarded-*` validates shape, not identity. Release risk remains: #117 (publish not gated on `Verify`) let
Release succeed on `769899c` while CI failed. See [the evidence](research/analog-header-validation-v09.md).

Evidence note (2026-10-24): the Analog 0.8.0 candidate adds `onRequestSettled`. A stream the transport never
reads or cancels, and a client that disconnects while a finite producer keeps running, are not reported until (and
unless) the body ends: Strata adds no timeout and does not claim a disconnect event. A broken observer is silent
by design (its errors are discarded so it cannot change the response), and Cloudflare Workers durations can read
`0` between I/O. Observation overhead is not measured. Fixture evidence, not production adoption. See
[the evidence](research/analog-request-observability-v08.md).

Evidence note (2026-10-22): the Analog 0.6.0 routing candidate adds an opt-in API boundary on top of Nitro's
H3 v1 router. It depends on pinned router behaviour (method-less registration serves every method, method
fall-through to less specific routes, no backtracking), so a router upgrade must be re-qualified; the H3 v2
transition is not qualified for it. Undeclared native routes are unknown to the boundary and answer `404` for a
wrong method. Separately, an intermittent Server Component SSR failure (HTTP 200 with an empty island and
`JIT compiler unavailable` in the log) was seen on PR #112 and reproduced once on main; its root cause was
unestablished when this note was written (superseded by the 2026-10-22 0.7.0 note above). See [the evidence](research/analog-http-routing-v06.md#baseline-ci-investigation).

Evidence note (2026-10-20): the Analog 0.5.0 HTTP contract candidate adds safe
application errors and portable `Response` helpers. Local Node and workerd
fixtures exercise them. Cancellation is **NO-GO** for the pinned adapter path:
Node H3 creates a synthetic Web Request without the socket abort signal, while
the Cloudflare Pages Nitro path does not forward the native incoming
`Request.signal` into `event.web.request`. `StrataAnalogRequest` therefore
exposes no signal. Cleanup still covers the awaited handler/interceptor
invocation, not the streamed response lifetime. See
[the contract evidence](research/analog-http-contract-v05.md#cancellation-investigation).

Evidence note (2026-10-20): request-scoped Analog interceptors are added on
`feat/analog-http-interceptors`. This provides an opt-in execution seam; it does
not qualify cancellation, streamed-response lifetime, production tracing or
application adoption. See
[the interceptor evidence](research/analog-http-interceptors.md).

Evidence note (2026-10-19): the Server Component dev recovery CI failure was traced to an
asynchronous harness log-window race; the test now gates the post-recovery assertion on observable
browser recovery and bounded log quiet, and scenario K proves a fresh invalid edit fails closed
after recovery. Hosted PR CI is pending; this does not change R05's production-security disposition
([evidence](research/server-component-dev-recovery-ci.md)).

Evidence note (2026-10-17): the feature branch
`feat/analog-standard-schema-validation` adds opt-in Standard Schema v1 input
validation for Analog, bounded JSON and safe 400/413/415 responses after
cleanup. Local Node production/dev, workerd and packed-consumer checks pass.
This does not close authentication, authorization, tenant isolation, general
error redaction or real-application adoption risks; see
[the evidence report](research/analog-input-validation.md).

Evidence note (2026-10-19): `feat/analog-request-guards` introduces the
registration-level Analog guard seam with explicit decisions and request-local
cleanup. Consumer identity verification is required; there is no framework
auth, session, RBAC/ABAC or CSRF policy. Local runtime and packed-consumer
evidence passes; hosted checks and production adoption remain unqualified. See
[the guard report](research/analog-request-guards.md).

Open as of 2026-09-17; R03, R04 and R13 updated 2026-09-24 with SPEC-003 evidence; R13 updated 2026-10-16 with the full-stack performance baseline and the one-versus-three-island scaling evidence. Astra owns architectural disposition; the agent executing the relevant spec
produces evidence. A risk closes only with a linked test/report on a pinned tuple. “Deadline” means
the gate that cannot pass unresolved, not a calendar estimate. No risk below is closed by this audit.

Evidence note (2026-09-28), no disposition changed: R05, R07, R08, R09 and R12 now have experimental
Server Component evidence on one code shape (Node and local workerd, document navigation only; Angular
Router navigation NO-GO) in the private `@strata-sc/server-components` package and the
[graph](research/server-component-graph-poc.md),
[navigation](research/server-component-navigation-poc.md) and
[Cloudflare](research/server-component-cloudflare-poc.md) reports.

Evidence note (2026-10-15, later), no disposition changed: the concurrency anomaly of run 2 was not reproduced
(local Node/workerd 829 requests each, existing deployment 478, new deployment run 38741663534 green); the
cause is **unconfirmed** and stays a residual risk, with classified anomaly capture now in the gate
([report](research/full-stack-cloudflare-concurrency.md)).

Evidence note (2026-10-15, after two real dispatches), no disposition changed: the full-stack workflow ran
twice against `strata-fullstack-qualification` and both runs are **NO-GO** (run 1 unreachable URL from the
runner; run 2 passed all functional and confidentiality checks on the public URL but had 1 anomalous
response in 25 concurrent controller requests, cause unknown). The "no deployed environment" part of R16/R17
stays open ([report](research/full-stack-deployed-cloudflare.md#deployment-record)).

Evidence note (2026-10-15, earlier), no disposition changed: `pnpm test:full-stack-deployed-cloudflare` builds
the same external full-stack consumer from source-packed tarballs for Cloudflare Pages and passes the
black-box verifier on local workerd; the manual workflow for the real deployment exists but **has not run
(REAL DEPLOYMENT: NOT RUN)**, so the "no deployed environment" part of R16/R17 stays open. A future GO
would cover a fixture on one isolated Pages project: no authentication or tenant-aware caching, no shared
controller/SSR DI, no bindings, and soft 404s, `/api/*` fallthrough and 200-on-render-error stay as
recorded ([report](research/full-stack-deployed-cloudflare.md)).

Evidence note (2026-10-15), no disposition changed: R16 and R17 gain one more fixture datum.
`pnpm test:full-stack-package-consumer` installs the three packed packages (`core` 0.2.1, `analog` 0.2.1,
`server-components` 0.2.0) into one external Analog app and runs a controller API, a server-only Server
Component and a hydrated island that calls the API, on Nitro and local workerd
([report](research/full-stack-external-consumer.md)). Controller and Angular SSR DI remain independent
(R03 unchanged); it is still a fixture, not a real application (R17 open), local workerd is not a
deployment, and unmatched `/api/*` paths fall through to Analog's HTML catch-all.

Evidence note (2026-10-05), R05 only: R05 is **partially resolved / substantially qualified** for
module-graph ownership, not closed. The private package's server-only assertion
(`import "@strata-sc/server-components/server-only"`) makes the build reject, with a diagnostic
naming module, importer and reason, every measured illegal browser import shape: direct, dynamic
`import()`, `@defer`-lazy, barrel, chained barrel, `?raw` and `?url` (real Vite production builds,
`pnpm test:server-component-server-only`). Marked modules and a synthetic canary stay in the Node and
Worker server graphs and out of every browser file and source map, with plugin-off positive controls.
Marked modules are also dogfooded by www and Relay. Dev evidence (2026-10-07,
[report](research/server-component-dev-hmr.md), `pnpm test:server-component-dev`): under the real
Analog dev server the graph is regenerated after every source edit, a module that starts asserting
server-only (or a barrel that starts re-exporting one) is refused to the browser live (import,
`import()`, `?raw`, `?url`) and an invalid graph fails the client closed until fixed, without
restarting Vite; bytes already delivered to a realm cannot be revoked, so the document reloads.
Remaining R05 gaps: Analog `liveReload: true` is not qualified for server-owned edits; the pre-scan follows relative, Vite-aliased and tsconfig-path re-exports under `sourceDir` (0.6
candidate; a marked module outside it, including a package module, is rejected only when its own
assertion import resolves in the browser, with the importer and chain the bundler reports; a package
that leaks without asserting is not detected; Analog's compile cache can serve a stale module that
left its TypeScript program); unmarked transitive dependencies are
protected by ownership, not by assertion; no deployed environment; data disclosure beyond modules is
R11.

Evidence note (2026-10-07), R11 only: R11 is **partially resolved / substantially qualified** for
server-owned _data_ crossing implicitly, not closed. `pnpm test:server-component-security` renders a
Server Component that uses a server-only repository holding a synthetic DATA canary and passes a
PUBLIC control canary through `[strataClient]`. On Nitro `node-server` and local workerd the DATA
canary, in any of its encodings, is absent from the raw SSR HTML (comments, inline scripts,
`ng-state`, `ngh`, `data-strata-*`), response headers, the parsed protocol v1 payload, the hydrated
DOM before and after an interaction, every public network response, the browser output and every
browser source map, the browser error surface and the output of a failed illegal-import build; it is
present in the server and Worker graphs, and the PUBLIC control is present everywhere it deliberately
crosses. Unsupported values (a repository instance, a nested object) are rejected with
`StrataBoundaryError` before serialization and the diagnostic prints no contents. Production errors
carrying the canary (plain, `Error.cause`, `AggregateError`) leave the public response clean on both
runtimes, with the original error only in the server log; no runtime code changed
([report](research/server-component-data-security.md)). Still open: authorization; tenant and cache
isolation; broader request-context lifecycle and tenant semantics are NOT QUALIFIED; origin and
CSRF rules for mutations; log and error-reporter redaction; the dev server; a real deployed
environment.

Evidence note (2026-10-07), failure and recovery; R08, R09, R10 and R11 are **not closed**:
[`pnpm test:server-component-failures`](research/server-component-failure-recovery.md) pins the buffered-SSR
failure contract on Node and local workerd. R09: a failing host is inert per host (preflight and commit
failures) while sibling hosts hydrate, one `ErrorHandler` report, same DOM nodes restored, no retry. R10: an
invalid value is never serialized, and the preflight error no longer quotes the payload (it could, through
some engines' `JSON.parse` messages). R11: failures add no data to public responses. R08: document navigation
into a failing route, Back and re-entry are clean lifecycles; Angular Router navigation stays NO-GO. New finding:
a Server Component render error answers HTTP 200 (an empty outlet, or a half-rendered component for a template
error) and no supported Strata seam can change that. Streaming is unsupported, not qualified.

Evidence note (2026-10-14), request context: the public Angular `REQUEST_CONTEXT`
token plus Analog's public per-render `platformProviders` seam now has a narrow
GO for Server Component buffered SSR. The service-isolation fixture adds an
allow-listed alpha/beta resolver, distinct synthetic private values, same-render
parent/child service identity, sequential/failure recovery, and deterministic
24-request overlap on Nitro node-server and local workerd. Missing or invalid
context renders an empty safe state and never selects another actor.
R11 remains open for authorization, tenant/cache isolation, logs, deployment and
broader lifecycle contracts.

Evidence note (2026-10-14), SSR response and expected recovery: R08, R09, R10 and R11 remain open
for the general failure contract. The public Analog `RESPONSE` token supports a narrow,
consumer-owned expected-service path: the fixture catches one typed repository failure and returns
generic HTML with HTTP 503/no-store, with 400/no-store for invalid context. The new
[response report](research/server-component-ssr-response.md) passes this path on Nitro and local
workerd, including overlap and document navigation. Unexpected Angular/Analog render failures
still answer HTTP 200; no general status bridge, fallback API or streaming contract was found.

Evidence note (2026-10-14), request-bound authorization: R04 and R11 remain open for production
identity, authorization, deployment, logging and tenant/cache semantics. The fixture-only
`pnpm test:server-component-authorization` gate resolves a synthetic principal from one opaque
HttpOnly cookie, ignores route/query/header identity overrides, authorizes the requested resource
before a request-local repository trace records a read, and passes 24-request mixed overlap on
Node and local workerd. It proves only a narrow synthetic trust model; it does not close
authorization, tenant-aware caching, origin/CSRF, sessions or Strata 1.0.

| ID  | Risk and impact                                                                   | Uncertainty today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Resolve by                                   | Experimental proof / fallback                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Package versus consumer standard decorator compilation                            | Partially proven: packed packages and consumer `tsc → JS → Vite → Node` work. Observed: direct Vite retains decorator syntax and Node rejects it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M1 baseline; M2 integration                  | Preserve SPEC-001 runtime evidence and its actual tuple limits; do not infer a public plugin or Angular AOT safety. Type errors are tracked separately below.                                                               |
| R02 | H3 major transition: incompatible Analog app/event contracts                      | Strata v2 RC vs Analog's researched Nitro 2/H3 1 lineage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M2 runtime choice                            | Pinned mounting/bridge experiment with cookies, errors, cancellation and path behavior; select one viable target or block integration.                                                                                      |
| R03 | Analog extension points: reliance on private bootstrap/compiler state             | SPEC-003 (2026-09-24): Analog 2.7.2 has **no** supported hook exposing its SSR or server-function injector; none is used. Reuse would need an upstream seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | M2, recheck M5                               | Trace pinned source; use documented APIs; enumerate private dependencies and upstream issue if needed. Unsupported hooks cannot masquerade as stable integration.                                                           |
| R04 | Angular DI: cross-request/tenant leaks or duplicate service instances             | Internal Node composition qualified (2026-10-20); minimal external packed Node profile partially qualified (2026-10-20): 24-request provider isolation, app service reuse, guard decisions, request cleanup and Nitro close hook. Still open: full external validation/interceptor/failure matrix, TS 5.9, bundle evidence, separate SSR/server-function injector, active-request shutdown, abort/cancellation, Workers and real application adoption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | M2 feasibility; M3 contract                  | Retain both reports and limits: [internal composition](research/analog-di-http-composition.md), [packed consumer](research/analog-packed-di-consumer.md); do not treat fixtures as real-application or Worker DI claims.    |
| R05 | Server/client graph separation: server implementation reaches browser             | Partially resolved / substantially qualified (2026-10-05, see note above). Dev server qualified for Analog's default configuration (2026-10-07); the packed private tarball splits the graph in an external Analog app outside the workspace (2026-10-08, Node and local workerd); open: pre-scan follows only relative re-exports under `sourceDir`; aliased imports lack an importer; no deployed env; data leaks are R11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | M2 no-go gate; enforce M4/M5                 | Production module graph plus all-output scans and positive server controls; direct/transitive/re-export/dynamic import negatives. If exclusion fails, no Server Component claim.                                            |
| R06 | Angular compiler integration: template/parent metadata needed in browser          | Standard decorators plus AOT, interactive descendants without parent implementation unproven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M2                                           | Compile/render real Angular template, remove parent from browser graph, prove child DOM reuse and interaction; record unsupported compositions. No CSR substitute.                                                          |
| R07 | Vite transform integration: correct build but broken dev/HMR or wrong environment | Current pre-pass may erase syntax before Angular analysis; virtual/query IDs and transform order untested                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | M2; stabilize M3                             | Trace resolved plugin order for client/SSR, virtual imports and invalidation; test production separately from HMR. Choose plugin/compiler only after result.                                                                |
| R08 | Client navigation: route changes require missing server code or stale DOM         | Consumer-owned Angular `canActivate` + browser document fallback is conditionally proven on Node and local workerd; SPA subtree hydration remains unsupported; `StrataDocumentLink`, `StrataDocumentNavigator` and the hardened guard now give a supported, tested document path, but an unguarded Router activation still renders the empty surrogate; the response gate covers document navigation only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | M2 probe; M4 decision                        | Keep route designation explicit; compare document navigation and router payload path with history, redirects, abort, focus/scroll and mixed routes. Block 1.0 on any claim of seamless SPA compatibility.                   |
| R09 | Hydration boundaries: children inert, events lost or duplicated                   | Nested hydration/@defer, projection and DOM ownership unknown; expected service recovery does not address unexpected render failures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M2 minimal; M4 full                          | Browser tests for DOM identity, exactly-once events, incremental triggers, event replay, nested/mixed routes and mismatch handling. `hydrate never` alone fails the requirement.                                            |
| R10 | Serialization: secrets, unsupported values, XSS or incompatible payload versions  | No supported value set/protocol; recovery fixture intentionally keeps repository errors out of HTML                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | M4 before protocol freeze                    | Round-trip/rejection tests, hostile strings, size limits, stale build IDs and explicit public-prop allowlists; no service/closure serialization.                                                                            |
| R11 | Server-only leaks beyond modules: HTML, transfer state, errors, caches            | Partially resolved / substantially qualified (2026-10-07, see note above): HTML, payload, hydrated DOM, network, browser output, source maps and production errors. Expected recovery adds no private error value; authorization, tenant/cache isolation, request context, logs, dev, deployment remain open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | M4, recheck real consumer M5                 | Synthetic secret canaries through HTML/payload/errors/maps; unauthorized fetches, tenant cache isolation, origin/CSRF rules for mutations; fail closed.                                                                     |
| R12 | Cloudflare portability: Node stubs, lifetime assumptions, runtime limits          | No Workers execution; Nitro output shape/version not qualified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M2 smoke; M3/M5 deployment                   | Actual workerd preview and cloud deployment, bindings/request scope, concurrency and resource measurements with pinned date/flags.                                                                                          |
| R13 | Bundle-size/runtime regressions: boundary machinery erases benefit                | No budget. SPEC-003 datum (Angular DI in a Nitro plugin traces `@angular/compiler`, server 4,492 → 7,716 KB) does not describe the current architecture. First controlled four-arm measurement (2026-10-16, one tiny fixture, Apple M4, [report](research/full-stack-performance-baseline.md)): browser +0 B controllers / +1.7 KiB gzip Server Components, server graph +11.1 KiB raw (Node) and +4.4 KiB gzip (Worker) for both; no latency/RSS effect above noise. Scaling (2026-10-16, [report](research/full-stack-performance-scaling.md)): with three distinct islands the Server Components browser overhead did not grow (+1.5 KiB gzip) and the full-stack server/Worker overhead stayed at about 10 to 11.5 KiB raw, on Apple M4 and on a GitHub-hosted runner, but the per-island marginal cost is confounded with server-only code exclusion and controller/provider-count scaling is unmeasured. Candidate budgets proposed, not enforced (browser: supported on this fixture; server: insufficient evidence); cold start, Worker memory, cancellation/cleanup and real apps NOT MEASURED | M2 measurement; M5 enforced budgets          | M2 measurement; M5 enforced budgets                                                                                                                                                                                         |
| R14 | Framework version compatibility                                                   | Observed standalone H3/TS declaration mismatch; Angular/Analog/Nitro tuple still untested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | M1 declaration contract; M2 tuple; M5 matrix | SPEC-002 qualifies or rejects the exact published type graph. No major upgrade or M2 advancement hides a failing M1 gate.                                                                                                   |
| R15 | Primitive semantics: inherited metadata, invalid members, route collisions        | Current tests cover independent classes; registration may partially mutate app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | M3 before HTTP stabilization                 | Specify supported inheritance/member/collision behavior first, then regression tests including siblings, overrides and repeated registration.                                                                               |
| R16 | Distribution, reproducibility and clean CI                                        | Partially proven: tarballs, rewritten dependency and one core pass. Observed: consumer Rolldown 1.2.9 differs from reported workspace 1.2.8; remote lint fails before build/consumer step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | M1 baseline; M5 publication                  | Assert actual consumer graph, build prerequisites before type-aware lint, rerun from a clean checkout and link CI. Published-package verification remains open.                                                             |
| R17 | Real application proof: fixture success does not cover production usage           | ForgeCMS not inspected or integrated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M5                                           | Fixture → candidate consumer → real deployment, with agreed objectives and rollback; equivalent consumer only with documented rationale.                                                                                    |
| R18 | H3 declaration compatibility                                                      | Observed: rc.32 public declarations fail strict TS 6.0.3 consumers; npm/latest and inspected post-rc.32 source have no fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | M1                                           | Distinguish upstream defect from Strata qualification responsibility. SPEC-002 must qualify a published closure or return a reproducible upstream blocker. A type-only import in Strata still exposes the dependency graph. |
| R19 | TypeScript/lib versus runtime contract                                            | Observed TS4113: H3 static override assumes `Error.isError`. Adding `esnext.error` removes only that error; Node 22.23.0 lacks the native method.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | M1 contract; recheck on tuple changes        | Record narrow lib requirements and runtime limits separately. No automatic TS 7/ESNext upgrade or polyfill; clean typechecking is not proof of native API availability.                                                     |
| R20 | Upstream optional peer type leakage                                               | Observed: H3 root imports optional crossws; published crossws 0.4.12 reaches Bun/Workers declarations. HTTP-only Node consumers encounter missing types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M1                                           | Fixed dependency-closure controls in SPEC-002; reject foreign ambient globals/suppression as qualification. If no clean published closure exists, retain no-go and a minimal upstream reproduction.                         |

Evidence: [SPEC-001 run](research/consumer-compilation.md), [Astra review and upstream research](research/h3-consumer-type-compatibility.md).
The observed declaration failures do not negate the positive decorator/runtime evidence. Neither
runtime success nor a completed no-go experiment closes M1. No new ADR is warranted by errors alone.

R10's 0.3.0 candidate adds a recursive allow-list validator for boundary protocol v2. Unit and
browser tests pin structural limits, UTF-8 size, dangerous keys, accessors, cycles, custom
serializers, proxy failures and v1/v2 mismatch handling. Relay Node production dogfood, Node/workerd
packed-consumer verification, and Node/workerd security scans pass, alongside the requested local CI
matrix. Hosted checks remain pending until push. R10 remains open because deployment and production
adoption are not qualified and protocol stability is not established. See
[boundary v2 evidence](research/server-component-boundary-v2.md).

The external-package-island candidate adds an explicit registry and exact named-import matching, but
its isolated package install did not complete in the restricted run. Do not treat analyzer tests or
the independently compiled tarball as Angular app-AOT, hydration, workerd or security qualification.
The remaining qualification gate is tracked in the
[package-island report](research/server-component-package-islands.md); the existing release and
production-adoption risks remain open.

## Review discipline

Each implementing PR identifies relevant IDs and attaches its evidence. Mark a risk “partially
resolved” if only a development, local, Node or synthetic path passed. A changed compiler, runtime
tuple or protocol reopens affected proofs. Move closed details into the responsible spec/report and
keep this register concise; do not turn uncertainty into an accepted ADR.
