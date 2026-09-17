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
- [ ] Normal interactive Angular descendants are shipped and hydrated without shipping the server
      parent; DOM reuse and exactly-once events are asserted.
- [ ] Initial SSR, direct URL loading and server-side service access work with request isolation.
- [ ] One navigation strategy is explicitly selected, documented and production-safe. Document
      navigation may qualify only with complete routing/history coverage and consumer acceptance;
      unsupported client subtree hydration is not advertised.
- [ ] Ordinary/incremental hydration and `@defer` coexist under documented composition rules,
      including nested/interacting boundaries and clear errors for unsupported shapes.
- [ ] Serialization value set, limits, escaping, boundary identity and version-skew behavior are
      stable and tested. Services, arbitrary closures and secrets cannot cross implicitly.
- [ ] Render, serialization, navigation and hydration failures have tested safe behavior; any
      streaming mode defines failure after headers, or streaming is explicitly unsupported.
- [ ] Authorization, direct payload access if present, tenant/cache isolation, error redaction and
      code/data-leak negative tests pass. Passing graph checks alone does not satisfy this item.

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
      rewriting and documented consumer build instructions work.
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
