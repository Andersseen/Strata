# Testing strategy and evidence

Tests should prove observable contracts and failure boundaries. The existing suite is summarized in
[STATE](STATE.md); everything below is required future evidence, not coverage already available.

## Progressive gates

| Gate | Required tests                                                                                                                                   | Evidence retained                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| M1   | Existing units/in-process H3 tests plus packed consumer types, compilation and execution                                                         | Exact tuple, tarball manifests/digests, commands, outputs and raw Vite characterization                            |
| M2   | Minimal Angular/Analog runtime mounting, DI concurrency/disposal, AOT and strict graph PoC; SSR plus one hydrated child; Workers smoke           | Pinned fixture, source/hook trace, build graphs and a go/no-go report                                              |
| M3   | Core semantics; H3 adapter integration; verbs/input validation/errors/guards/interceptors; Angular providers and Analog SSR/serverFn coexistence | Contract tests through public APIs, failure/abort cases, Node/Workers results                                      |
| M4   | SSR, hydration, incremental hydration/@defer, navigation, serialization, graph assertions and negative leaks                                     | Production browser/e2e reports, client/server graph artifacts and negative-test diagnostics                        |
| M5   | Node/Cloudflare deployment, package publication, load/cleanup, compatibility matrix and real application e2e                                     | Candidate digest, deployment records, runtime versions/config, consumer revision, operational and rollback results |

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
