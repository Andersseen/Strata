# Strata 1.0 exit criteria

**Current status: none of these production gates is certified.** This checklist is authoritative
for release readiness. Fill each item with evidence for one release candidate and its qualified
compatibility matrix; do not check it based on intent or a demonstration.

## Framework

- [ ] Stable documented public API with supported member/inheritance/registration semantics.
- [ ] Controllers, request inputs, validation, safe errors, providers/lifetimes and authorization
      are usable in real applications; the chosen guard/interceptor execution model is tested.
- [ ] Angular/Analog integration and consumer compilation pass development and production checks
      through the documented supported extension points.
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
      aliased/package re-exports are not propagated by the pre-scan and an aliased
      import is rejected only by the `load` backstop without naming its importer; local Node and
      workerd only.
- [ ] Normal interactive Angular descendants are shipped and hydrated without shipping the server
      parent; DOM reuse and exactly-once events are asserted.
- [ ] Initial SSR, direct URL loading and server-side service access work with request isolation.
- [ ] One navigation strategy is explicitly selected, documented and production-safe. Document
      navigation may qualify only with complete routing/history coverage and consumer acceptance;
      unsupported client subtree hydration is not advertised.
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
      _Evidence so far (not certified):_ preview protocol v1 is tested for each of these (see
      [STATE](STATE.md), "Client boundary protocol v1"). Still open: the protocol is not stable,
      only one primitive value set exists, and it is qualified on local Node and workerd only.
- [ ] Render, serialization, navigation and hydration failures have tested safe behavior; any
      streaming mode defines failure after headers, or streaming is explicitly unsupported.
      _Evidence so far (not certified; box left unticked):_ for the preview, buffered-SSR and
      document-navigation contract only, `pnpm test:server-component-failures` (Node and local workerd,
      [report](research/server-component-failure-recovery.md)) pins render, serialization, preflight, commit
      rollback, sibling-host isolation and navigation/Back/re-entry failures with one `ErrorHandler`
      report each and no retry; streaming is explicitly **unsupported** (not qualified). Still open: a
      Server Component render error answers HTTP 200 (empty outlet or half-rendered component) with no
      supported Strata seam to change it, there is no fallback API, Router navigation into a Server
      Component subtree is NO-GO, a deployed environment is unqualified (dev/HMR is qualified for Analog's default configuration, see the
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
      tenant and cache isolation, a request context for Server Components, origin/CSRF rules, log
      redaction and a real deployed environment.

## Deployment

- [ ] Production fixture with controllers/services and Server Components deployed successfully.
- [ ] Supported Node version and actual built server entry point validated.
- [ ] Cloudflare deployment validated with the complete Analog SSR/component path; Workers execution,
      deployment shape, Nitro preset, compatibility date/flags and bindings are recorded.
- [ ] Resource use, cold start, concurrent requests, cancellation and cleanup measured; agreed
      service and bundle budgets pass on each claimed runtime.
- [ ] Release/rollback procedure tested, including client assets from an older deployment.

## Quality and distribution

- [ ] Unit, adapter, Angular/Analog integration, SSR, browser hydration and navigation tests pass.
- [ ] Production bundle assertions and adversarial leak detectors include positive controls.
- [ ] Small explicit compatibility matrix with exact tested tuples, engine/peer ranges and CI links.
- [ ] Published candidate installs cleanly outside the workspace; exports, declarations, dependency
      rewriting and documented consumer build instructions work. Not ticked: there is no published
      candidate. Evidence so far for `@strata-sc/server-components` only: **private tarball external-consumer
      qualification** (`pnpm test:server-component-package-consumer`,
      [report](research/server-component-package-consumer.md)) — the packed, still private package
      installs with `npm` into a real Analog app outside the workspace; exports, declarations (TypeScript
      6.0.3 and 5.9.2), Node build/SSR/hydration, the server-only firewall, `vite` dev and a Cloudflare
      build on local workerd work from `node_modules`. It is not a registry install, not a version and not
      a release; `@strata-sc/core` and `@strata-sc/analog` are covered by `test:package-consumer`.
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
