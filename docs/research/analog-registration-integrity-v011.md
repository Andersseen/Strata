# Analog route registration integrity — 0.11.0 candidate

## Scope and starting point

This increment targets `@strata-sc/analog` 0.10.0 → 0.11.0. Work began from synchronized `origin/main` SHA `7ac01d44f7c4f20f0817dca661cad135ed956f44` on `feat/analog-route-registration-integrity-v011`. The working tree was clean before implementation. The existing Server Components 0.10.0 Changeset was preserved. This is an Analog registration preflight change; it does not close M3 or certify Strata 1.0.

Exact installed runtime tuple relevant to routing: Node 22.23.1, pnpm 10.30.1, Analog platform 2.7.2, Analog router 2.8.1, Nitro 2.13.4, H3 1.15.11 and Vite 8.3.0. The lockfile/fixture supply these versions; this is not a broad compatibility range claim.

## Baseline against the real router

Before changing the adapter, a focused executable reproduction used `createApp`, `createRouter({ preemptive: true })` and `toWebHandler` from the installed H3 1.15.11 package, the router Nitro/Analog uses.

- GET `/products/:id` followed by GET `/products/:slug` both registered successfully. `/products/42` reached only the first owner and exposed its parameter name. Reversing order reversed both owner and parameter key.
- Separate Strata registration calls had the same first-registration behavior, with and without `apiBoundary`.
- GET `/:id` and POST `/:slug` both registered and both methods reached a handler, but both received the parameter name belonging to whichever template registered first. Nitro shares structural parameter metadata across methods.
- The exact same final template on GET and POST works and supplies the same parameter key to both handlers.
- Static `/products/new` and parameter `/products/:id` remain distinct and Nitro routes the static path correctly.
- Exact method/path duplicates remain a separate existing preflight error.

Thus method differences do not make differently named parameter templates safe on this pinned router. Identical path templates on different methods remain valid.

## Implementation and contract

Registration planning derives the identity from each normalized final route path (`buildRoutePath()`), using the existing `compilePattern()` and `shapeOf()` functions. A Map tracks supported shapes from prior Strata-owned routes plus the new batch. Exact duplicate method/path validation remains. A supported shape collision is rejected when its final path template differs, regardless of HTTP method, before any planned route is committed.

The `StrataAnalogConfigurationError` names the method, both final templates and both controller/handler owners, identifies whether the conflict is within the current batch or against a prior Strata route on that router, explains that parameter names do not create distinct Nitro routes and recommends changing a static segment. No request data or source text is included.

The state remains a WeakMap keyed by router. Different router instances do not share registrations. Same-template routes for different methods are allowed. Static route identity differs from parameter identity. Root and nested routes continue through the existing normalized path builder.

Existing `apiBoundary` checks continue to validate its owned path grammar and declared native route metadata; the Strata-to-Strata shape comparison is centralized in registration planning. This applies whether the boundary is absent, is introduced after existing Strata registrations, or routes are registered after boundary configuration.

### Supported grammar and limits

The existing shape compiler models static segments and whole-segment named parameters. Patterns for which it returns `undefined` (including wildcard/catch-all and other Nitro-specific forms) are not newly rejected outside the API-boundary grammar. Exact duplicate checks still apply. This change does not claim complete ambiguity detection for unsupported syntax.

Strata only sees its own WeakMap records. It does not inspect Nitro private router state, intercept native routes, or detect undeclared native collisions. Native Nitro routes remain Nitro-owned; `apiBoundary.nativeRoutes` remains consumer-declared metadata. No Analog page or serverFn route ownership is inferred.

Configuration preflight is atomic: errors leave the router and WeakMap unchanged, previous valid routes remain usable, and later valid calls can succeed. Arbitrary rollback after `router.add()` itself throws partway through commit is not guaranteed; no private router mutation was added.

## Regression coverage

The Analog suite now passes 247 tests. New coverage includes both controller orders, intra-batch and cross-call collisions, with/without boundary, cross-method parameter mismatch, identical cross-method templates, static-plus-parameter behavior, failed-batch atomicity, prior-route usability, later valid registration, native route coexistence, router isolation and an actual H3 wildcard request. Existing tests continue to cover metadata ownership/inheritance, decorated and shadowed members, accessors, noncallable handlers, protected methods, multiple HTTP decorators, frozen metadata, boundary 404/405/HEAD/OPTIONS, guards/interceptors, factories/cleanup and `onRequestSettled` behavior.

No core metadata semantics or public observation types changed. Registration failure is pre-request, so it constructs no controller, executes no guard/interceptor and emits no request-settled observation. Valid request lifecycle and HTTP validation suites passed as listed below.

## Local integration evidence

The following all passed on the pinned local toolchain:

- `pnpm build`, `pnpm lint` (two pre-existing warnings, zero errors), `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm --filter @strata-sc/analog test` (247/247), `pnpm test:release`, and `pnpm test:performance-tools` (also run under `pnpm test`).
- Analog Node production, Vite dev, and local Cloudflare Pages/workerd scripts: `test:analog`, `test:analog-headers`, `test:analog-forms`, `test:analog-observability`, and `test:analog-streaming`.
- Packed external consumers: `test:package-consumer`, `test:analog-packed-di-consumer`, `test:full-stack-package-consumer`, and `test:server-component-package-consumer`. These install built tarballs outside the workspace; strict declaration checks use TypeScript 6.0.3 and 5.9.2 where qualified, with `skipLibCheck: false`, and exercise Node plus local workerd as applicable.
- Server Components regression commands passed: `test:server-components`, navigation, defer, optimized-deps, security, request-context, authorization, failures, SSR-response, dev, deployment-skew, Cloudflare local, website and Relay integration. The requested root script `test:server-component-server-only` does not exist; the package unit suite includes `src/vite/server-only.test.ts`, and packed/runtime checks passed.
- `test:full-stack-deployed-cloudflare` passed its local packed consumer/workerd rehearsal (779 requests, zero anomalous); its own output confirms **real deployment not run**.
- `pnpm www:build:cloudflare` passed. Website and Relay Playwright E2E passed (2 and 6 tests) against freshly built production apps on isolated ports. An unrelated process on default port 3000 was left untouched.
- `pnpm test:package-consumer` passed the packed H3 v1 registration consumer and failed-batch no-mutation assertion.

## Startup performance

`pnpm test:analog-registration-performance` runs nine repetitions against the real locked H3 router and reports median registration time for unique static routes. Latest measured medians: 1 route 0.056 ms, 100 routes 0.205 ms, 400 routes 1.311 ms. These are local fixture measurements, not a general latency guarantee. The check is a startup preflight benchmark; the implementation adds no request-time shape scan. A matched-request before/after latency comparison was not run, so no comparative request-latency claim is made.

## Release, CI and remaining qualification

One Changeset targets only `@strata-sc/analog` with a minor bump; package version files were not edited. `pnpm changeset status` passed and reports the existing pending Server Components changeset as well; it remains untouched.

PR #145 (`814998edaf7fd0407e1227f7d4d0c772d25db0cd`) hosted Verify run `40572381749` completed successfully: lint/typecheck/unit tests, graph/SSR/hydration/firewall, runtime Node/workerd contracts, and Website/Relay dogfood all passed; the package build passed, and deploy was skipped. This is hosted-CI qualification for the candidate commit, not deployed qualification. The current main SHA's CI run `40509315597` and its `workflow_run` Release `40513924914` also completed successfully for exact SHA `7ac01d44f7c4f20f0817dca661cad135ed956f44`. The release workflow and `tools/release/authorize.ts` were inspected: release authorization requires the successful aggregate Verify for the exact main SHA, checks current main, and rechecks before Changesets. This proves successful transitions on main; it does not prove pending/failure/cancelled/stale-SHA rejection. Issue #117 remains open. No release was published.

`pnpm release:packages:dry-run` built and inspected tarballs, then could not complete its npm publish simulation: the default cache is root-owned and an alternate `/private/tmp` cache still could not resolve npm (`ENOTFOUND`). No publication occurred. `pnpm release:sync-dist-tags:dry-run` passed; its dry-run found the unpublished Analog 0.10.0 and Server Components 0.9.0 absent from npm and skipped them. `npx --yes @entwine/cli@0.5.1 check` could not download/start under the restricted network and was stopped after no output; `build` was therefore not run. `pnpm test:consumer:types` likewise did not progress past its temporary workspace/historical control while external dependencies were unreachable, and was stopped. These are **not reproducible locally in this environment**, not passing checks. `pnpm format:check` and `pnpm changeset status` pass.

No Cloudflare deployment, npm publication or production adoption was performed. Local workerd is local integration evidence only. M3 remains open for the broader cancellation, serverFn/SSR DI composition, worker AOT, and contract qualification gaps already recorded in the roadmap; M4 browser/graph and M5 deployed/adoption gates remain open.
