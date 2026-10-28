# Strata 1.0 exit criteria

Analog's opt-in Standard Schema v1 input methods are additive experimental
APIs. The bounded JSON and safe client-input response contract has local Node,
workerd and packed-consumer fixture evidence; this does not certify M3 or
Strata 1.0. See
[the validation evidence](research/analog-input-validation.md).

The 0.10.0 candidate adds bounded, opt-in URL-encoded form validation. Its unit
suite, real Node production, Analog dev, local workerd fixture and packed consumer
pass; hosted CI and deployed qualification remain open. Its 1 MiB byte limit
and 10,000-field cap, strict malformed-encoding response and body-reader
ownership do not provide CSRF protection. See
[the form evidence](research/analog-validated-forms-v010.md).

The 0.11.0 Analog candidate adds configuration-preflight protection for Strata-owned equivalent
route templates on Nitro/H3 v1. It does not detect undeclared native route collisions, roll back
arbitrary `router.add()` failures, or cover Nitro syntax outside the supported shape grammar. This
candidate alone does not close M3; see [the registration integrity evidence](research/analog-registration-integrity-v011.md).

The same candidate replaces Release's push-to-main trigger with an exact-CI
`workflow_run` gate for issue #117. This is not a release-safety closure until
the merged workflow has been observed handling the hosted success, failure,
cancelled, pending and stale-main transitions; see the verification evidence
and remaining live checks in the [form report](research/analog-validated-forms-v010.md).

Analog's opt-in request guards are also experimental. They delegate identity
verification and authorization to the application and do not qualify
production authentication, tenant isolation, CSRF handling or real application
adoption. Request-scoped interceptors are now implemented experimentally,
with their own ordering and `next()` contract; they do not provide
authentication, cancellation qualification or production tracing. See the
[guard report](research/analog-request-guards.md) and
[interceptor report](research/analog-http-interceptors.md).

The 0.5.0 candidate adds safe typed application HTTP errors and native JSON / 204
helpers with local Node, workerd and external packed-consumer evidence. It does
not qualify a production authentication policy, a deployed runtime, cancellation
through the current Nitro adapters, streamed-response cleanup or real-application
adoption. These checks do not complete M3 or Strata 1.0; see the
[HTTP contract report](research/analog-http-contract-v05.md).

The 0.8.0 candidate adds an opt-in Server Components build identity and bounded recovery for deployment skew
(local Node and workerd evidence only; no deployed run, no hosted-CI record when written). The "version-skew
behavior" item below stays open: protocol stability and a deployed qualification are not shown. M4 and M5 are not
marked complete.

The 0.10.0 Server Components candidate adds `provideStrataHydrationObserver()` for an immutable, privacy-safe
terminal observation of Strata's per-host commit attempt. Evidence levels and remaining qualification gaps are
recorded in the [candidate report](research/server-component-hydration-observability-v010.md). This does not
complete M4 or Strata 1.0 and does not monitor Angular after the host transaction.

The 0.8.0 candidate adds an opt-in `onRequestSettled` request observation (safe route/outcome/cleanup/duration
facts, exactly once after cleanup, streams at a supported terminal outcome, isolated from the response).
Implemented, unit tested, locally integrated (Node, dev, local workerd) and packed-consumer qualified; not
hosted-CI qualified when written, not deployed, not adopted. It does not observe client disconnect and does not
complete M3 or Strata 1.0 ([report](research/analog-request-observability-v08.md)). Publishing is still not gated
on CI (issue #117).

The 0.9.0 candidate adds opt-in `validateHeaders(schema)` (Standard Schema v1, safe `source: "headers"` 400, cleanup-first,
observed as `input-rejected`). Implemented, unit tested, locally integrated and packed-consumer type-qualified; not
hosted-CI qualified, deployed or adopted. It does not complete M3 or Strata 1.0, and #117 still blocks a safe publish
([report](research/analog-header-validation-v09.md)).

The 0.7.0 candidate adds `streamResponse()`, an opt-in streaming lifetime for the request cleanup scope, and
executes a real compiled Analog `serverFn` next to Strata in the fixture. Locally integrated on Node (production
and dev) and local workerd, and packed-consumer qualified on Node and workerd; not hosted-CI qualified at the time
of writing, not deployed, not adopted. Still **NO-GO**: client-disconnect cancellation through the pinned Nitro
adapters (no abort signal reaches the body, so a streamed body must be finite), incremental delivery on the
Cloudflare Pages preset (the body is buffered), a client-visible failure signal after a body fails mid-stream on
either runtime, and `serverFn` on workerd (Angular JIT). It does not complete M3 or Strata 1.0
([report](research/analog-stream-lifecycle-v07.md)).

The 0.6.0 candidate adds an opt-in HTTP routing and API boundary (JSON 404, 405 with `Allow`, derived
`HEAD`, opt-in `OPTIONS`) with local Node, workerd and packed-consumer evidence. It is not an authentication,
CORS or CSRF policy, did not exercise a real Analog server function (the 0.7.0 report now does), and does not qualify a deployed runtime;
it does not complete M3 or Strata 1.0 ([report](research/analog-http-routing-v06.md)).

**Current status: none of these production gates is certified.** This checklist is authoritative
for release readiness. Fill each item with evidence for one release candidate and its qualified
compatibility matrix; do not check it based on intent or a demonstration.

## Framework

- [ ] Stable documented public API with supported member/inheritance/registration semantics.
- [ ] Controllers, request inputs, validation, safe errors, providers/lifetimes and authorization
      are usable in real applications; the chosen guard/interceptor execution model is tested.
- [ ] Angular/Analog integration and consumer compilation pass development and production checks
      through the documented supported extension points.
      The 2026-10-20 [DI HTTP composition report](research/analog-di-http-composition.md)
      qualifies the internal fixture on Node; the minimal external packed Node profile is only
      partially qualified ([report](research/analog-packed-di-consumer.md)). The full packed
      validation/failure/bundle matrix, shared SSR/controller DI, real application adoption and the
      known workerd JIT limitation remain open, so this release gate stays unticked.
- [ ] Strata uses no legacy decorators, parameter decorators, `emitDecoratorMetadata` or
      `reflect-metadata`; compiler coexistence with Angular is demonstrated.
- [ ] Core remains independent of H3/Angular/Nitro; packages each have an owned responsibility.
- [ ] Native H3 routes and escape hatches coexist; internal RPC remains compatible with Analog
      server functions.

## Server Components

- [ ] Actual server/client graph split, including compiled implementation/template code.
- [ ] Server implementation excluded from every browser chunk, asset and public source map.
- [ ] Server-only dependencies excluded transitively; direct, re-exported and dynamic illegal
      imports fail closed with useful diagnostics.
      _Evidence so far (not certified):_ the private package's
      `import "@strata-sc/server-components/server-only"` assertion fails real production builds
      for direct, dynamic `import()`, `@defer`-lazy, barrel, chained-barrel, `?raw` and `?url`
      browser imports, each with a diagnostic naming the module, the importer, the reason (with the
      re-export chain) and the fix; a legal Server Component → marked repository build and a shared
      module imported by both a marked module and an island build. A synthetic canary and the marked
      modules are present in the Node SSR/Nitro and Worker server graphs and absent from browser JS,
      assets and source maps, with plugin-off positive controls (fixture, www and Relay; see
      [STATE](STATE.md), "Server-only modules"). Not ticked: no release candidate; the dev server is
      qualified for Analog's default configuration ([report](research/server-component-dev-hmr.md): live
      firewall, regeneration, fail-closed recovery) but that is not a release certification;
      aliased re-exports (Vite aliases, tsconfig paths, index files) are followed by the pre-scan
      and a package module that asserts server-only fails the client build, with the importer and
      import chain the bundler knows (0.6 candidate,
      [report](research/server-component-graph-security-v06.md)); package re-exports are not
      crawled, a package that leaks without asserting is not detected; in dev, pre-bundled package
      modules that assert are refused by the optimizer firewall (0.9 candidate,
      [report](research/server-component-optimized-dependency-firewall-v09.md)) but the importer above an optimizer entry is unavailable, a warm cache
      survives an in-place edit, and a failed first optimizer run ends `vite` dev; local Node and
      workerd only.
- [ ] Normal interactive Angular descendants are shipped and hydrated without shipping the server
      parent; DOM reuse and exactly-once events are asserted.
- [ ] Initial SSR, direct URL loading and server-side service access work with request isolation.
      _Evidence so far (not certified):_ Angular's public `REQUEST_CONTEXT` provider seam is
      qualified narrowly for buffered Server Component SSR on Nitro node-server and local
      workerd with 24 overlapping alpha/beta requests in both orders
      ([request-context report](research/server-component-request-context.md)); this does not
      qualify tenant isolation, authorization, Router navigation or streaming.
      The follow-up service-isolation fixture uses distinct synthetic alpha/beta
      private values, explicit allow-listed identity resolution, shared parent/child
      service-instance evidence, failure/recovery checks and the same Node/workerd
      overlap gate ([isolation report](research/server-component-request-isolation.md)).
- [ ] One navigation strategy is explicitly selected, documented and production-safe. Explicit
      document navigation is supported through `StrataDocumentLink`, `StrataDocumentNavigator` and
      `strataDocumentNavigationGuard` ([report](research/server-component-document-navigation-v04.md)),
      still a full reload, not seamless SPA navigation; unguarded Router activation is still the
      empty surrogate. Unsupported client subtree hydration is not
      advertised and Strata 1.0 remains unqualified.
- [ ] Ordinary/incremental hydration and `@defer` coexist under documented composition rules,
      including nested/interacting boundaries and clear errors for unsupported shapes.
      _Evidence so far (not certified):_ `@defer` inside a `[strataClient]` component is
      Angular-owned and qualified for `hydrate on interaction` (lazy chunk on the trigger, event
      replay, DOM reuse) and `hydrate on viewport`, under a server-owned child, on local Node and
      workerd, with bundle evidence and Relay dogfood; every `@defer` in a server-owned template
      fails the build with a shape-specific diagnostic (see [STATE](STATE.md), "Server Components
      and Angular `@defer`"). Still open: other hydrate triggers, defer inside an island nested in
      another island's subtree, Angular Router navigation into such a route, Analog's
      `ngServerMode` SSR define (app-level workaround), and a deployed environment.
- [ ] Serialization value set, limits, escaping, boundary identity and version-skew behavior are
      stable and tested. Services, arbitrary closures and secrets cannot cross implicitly.
      _Evidence so far (not certified):_ preview protocols v1 and v2 cover flat primitives and
      bounded structured JSON respectively (see [STATE](STATE.md), "Client boundary protocol v2"
      and its research report). Still open: the protocol is experimental, production support is
      unqualified, and this increment does not close the remaining M4/M5 gates.
- [ ] Render, serialization, navigation and hydration failures have tested safe behavior; any
      streaming mode defines failure after headers, or streaming is explicitly unsupported.
      _Evidence so far (not certified; box left unticked):_ for the preview, buffered-SSR and
      document-navigation contract only, `pnpm test:server-component-failures` (Node and local workerd,
      [report](research/server-component-failure-recovery.md)) pins render, serialization, preflight, commit
      rollback, sibling-host isolation and navigation/Back/re-entry failures with one `ErrorHandler`
      report each and no retry; streaming is explicitly **unsupported** (not qualified). Still open: a
      Server Component render error answers HTTP 200 (empty outlet or half-rendered component) with no
      supported general Strata seam to change it. The narrow consumer-owned expected-service
      recovery fixture passes HTTP 503/no-store on Node and local workerd, but is not a general
      fallback API and does not close this criterion ([report](research/server-component-ssr-response.md)).
      The 0.7 candidate adds a build-time production compilation gate and class-labelled SSR integrity
      assertions (an HTTP 200 alone no longer passes a qualification), so a missing compilation, the one
      observed cause of an HTTP 200 shell, is stopped before deployment; it does not change the status of
      any other render error ([report](research/server-component-ssr-integrity-v07.md)).
      Router navigation into a Server
      Component subtree is NO-GO, the complete Analog deployment is unqualified (Server Components alone: narrow Cloudflare Pages GO, see the [deployed report](research/server-component-deployed-cloudflare.md)) (dev/HMR is qualified for Analog's default configuration, see the
      [dev report](research/server-component-dev-hmr.md)), and release-candidate
      evidence is absent.
- [ ] Authorization, direct payload access if present, tenant/cache isolation, error redaction and
      code/data-leak negative tests pass. Passing graph checks alone does not satisfy this item.
      _Evidence so far (not certified):_ synthetic-canary leak qualification of server-owned data
      on HTML, headers, boundary payload, hydrated DOM, network, browser output, source maps,
      secret-bearing production errors and build diagnostics, with a PUBLIC positive control and a
      server-graph positive control, on Node and local workerd
      ([report](research/server-component-data-security.md),
      `pnpm test:server-component-security`). Still open, and why this stays unchecked: authorization,
      tenant and cache isolation, broader request-context lifecycle contracts, origin/CSRF rules, log
      redaction and a real deployed environment. A follow-up fixture now provides narrow synthetic
      authorization evidence (`pnpm test:server-component-authorization`) with an opaque HttpOnly
      test cookie, server-side ownership checks before repository access, 401/403/404 no-store
      responses, Node/workerd overlap and browser navigation ([report](research/server-component-authorization-isolation.md)).
      It does not qualify production authentication, sessions, tenant-aware caching or this 1.0 item.

## Deployment

- [ ] Production fixture with controllers/services and Server Components deployed successfully.
- [ ] Supported Node version and actual built server entry point validated.
- [ ] Cloudflare deployment validated with the complete Analog SSR/component path; Workers execution,
      deployment shape, Nitro preset, compatibility date/flags and bindings are recorded.
      _Evidence so far (not certified; box left unticked):_ the published `@strata-sc/server-components@0.1.0`
      builds for Cloudflare Pages in an external app and passes the full verifier on local workerd
      (preset, compatibility date and flags recorded in
      [the report](research/server-component-deployed-cloudflare.md)). The real deployment to the isolated
      `strata-sc-qualification` project is **QUALIFIED for Server Components only (GO, narrow)**: the fifth
      deployment (Actions run 38243892864, `main` at `2c3f495c`, 2026-10-12) passed the whole verifier from a
      GitHub runner with 0 failed checks (readiness, SSR, protocol v1/v2, hydration, interaction, document
      navigation, confidentiality, 5/10/25 request smoke). The first four runs failed and are kept in the report.
      This item also asks for the complete Analog SSR/controller path and bindings, which the external fixture
      does not cover, so it **stays unticked**.
- [ ] Resource use, cold start, concurrent requests, cancellation and cleanup measured; agreed
      service and bundle budgets pass on each claimed runtime.
  - Partial evidence only (2026-10-16): [bundle-size and warm HTTP/SSR baseline](research/full-stack-performance-baseline.md) on Node and local workerd. Cold start, Worker memory, cancellation/cleanup and deployed latency are NOT MEASURED; budgets are unenforced proposals. **Not closed.**
  - Scaling evidence (2026-10-16): [one versus three distinct islands](research/full-stack-performance-scaling.md) on local and GitHub-hosted runners; the Server Components browser overhead did not grow, the PR #86 candidate budgets are still unenforced proposals and the server budget lacks a controller/provider-count dimension. **Still not closed.**
- [ ] Release/rollback procedure tested, including client assets from an older deployment.

## Quality and distribution

- [ ] Unit, adapter, Angular/Analog integration, SSR, browser hydration and navigation tests pass.
- [ ] Production bundle assertions and adversarial leak detectors include positive controls.
- [ ] Small explicit compatibility matrix with exact tested tuples, engine/peer ranges and CI links.
- [x] Published candidate installs cleanly outside the workspace; exports, declarations, dependency
      rewriting and documented consumer build instructions work. Evidence for
      `@strata-sc/server-components` **only** (`core`/`analog` are covered by `test:package-consumer`;
      not a 1.0 claim): `@strata-sc/server-components@0.1.0` is on npm (`next` → `0.1.0`) and the
      registry consumer (`pnpm test:server-component-registry-consumer`, rerunnable via the
      "Verify published Server Components" workflow) passes against it: fresh `npm install` of the
      exact version outside the workspace, real non-symlink install, no workspace resolution,
      production build, graph isolation, SSR, protocol v1/v2, hydration, one interaction and the
      server-only firewall ([report](research/server-component-first-release.md#publication-and-registry-evidence)).
      The packed-tarball consumer stays GO, with declarations qualified under TypeScript 6.0.3 and
      5.9.2 and consumer setup documented in the package README
      ([report](research/server-component-package-consumer.md)).
      External Angular package islands are a separate experimental candidate: their partial-compiled
      tarball fixture exists, but its npm install/AOT/runtime gate has not passed, so arbitrary package
      components are not a 1.0 capability
      ([report](research/server-component-package-islands.md)).
      `pnpm test:full-stack-package-consumer` adds one app using all three packed packages together
      (controller API + hydrated island + Server Component, Node and local workerd;
      [report](research/full-stack-external-consumer.md)). It is a fixture: it does not close real-application
      adoption, deployment, shared controller/SSR DI or this gate.
      `pnpm test:full-stack-deployed-cloudflare` and the manual `full-stack-deployed-cloudflare.yml` add the
      machinery to deploy that same app (source-packed candidate) to the isolated
      `strata-fullstack-qualification` project; locally it passes the Cloudflare build and a workerd
      rehearsal. The real deployment was dispatched twice on 2026-10-15 and **both runs are NO-GO** (second run: all
      functional checks passed publicly, the concurrency smoke had one anomaly), so the complete-path deployment gates
      above stay unticked ([report](research/full-stack-deployed-cloudflare.md)). A later manual run on a
      diagnostic branch ([38741663534](https://github.com/Andersseen/Strata/actions/runs/38741663534)) passed
      every check for that source-packed fixture; the anomaly's cause remains unconfirmed and a fixture
      pass does not close the criterion ([report](research/full-stack-cloudflare-concurrency.md)).
- [ ] SemVer, prerelease handling, deprecation and migration policy documented; upgrades exercised.
- [ ] Public documentation, examples, error diagnostics and native H3 escape-hatch guidance complete.
- [ ] Architectural/security blockers in RISKS have evidence-backed dispositions; no unresolved
      requirement is relabeled unsupported merely to pass the release audit.

## Real-world proof

- [ ] At least one real application uses the production path: controllers/services, strict Server
      Components, interactive descendants and selected navigation strategy.
- [ ] Prefer ForgeCMS after controlled fixtures pass; if replaced, record suitability and equivalent
      coverage. Strata has no dependency on that application's APIs or schema.
- [ ] Record consumer revision, installed candidate, deployment, automated e2e/bundle evidence,
      actual operational use and agreed observation objectives/results. A fixture alone is not enough.
- [ ] Consumer migration and rollback verified; material issues resolved and evidence rerun.

## Release record

At M5 create a dated release evidence record linking each item to tests, CI artifacts, deployment
results and consumer evidence, including candidate digest and exact tuple. Astra records its
architectural review and maintainers record the release decision. Do not create a fictional
completed release record now. Any unchecked required item keeps Strata below 1.0.
