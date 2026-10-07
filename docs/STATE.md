# Current implementation audit

## Reconciliation 2026-09-24

Inspected at `c671ba4` (`main`, merge of PR #19) plus the SPEC-003 branch. The sections after this
one are the 2026-09-17 audit at `f258fc3`. They are kept as recorded, and this section supersedes
their current-state claims where the two differ. Work now runs on two tracks with independent gates:

| Track                                             | Scope                                                                    | State                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H3 consumer qualification                         | `@strata-sc/h3` (H3 v2) packed consumers, strict declarations; M1        | SPEC-001 and SPEC-002 executed. **Upstream-blocked**: H3's `HTTPError.isError` lib assumption and its crossws import graph fail strict TS 6.0.3 consumers; no published closure qualifies. `pnpm test:consumer` stays failing on AC2 by design. Unchanged by later work.                    |
| Analog integration / Server Component feasibility | `@strata-sc/analog` (Nitro 2 / H3 v1) inside a real Analog 2.7.2 app; M2 | Executed and passing in dev and production ([baseline](research/analog-integration-baseline.md)). `@strata-sc/analog` exposes no H3 v2 (or v1) declarations, so the H3 type blocker does not apply to it. Packed-consumer qualification of `@strata-sc/analog` itself has **not** been run. |

Analog track increments since the 2026-09-17 audit:

| PR / spec   | Increment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #7          | Analog integration baseline fixture and `pnpm test:analog`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| #8          | `@strata-sc/analog`: `registerControllers(nitroApp.router, …)` from a Nitro plugin; depends only on `@strata-sc/core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| #17         | Provisional `StrataAnalogRequest` (method, path, URL, headers, params, query, context snapshot, lazy body readers); Nitro/H3 event not exposed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| #18         | Controllers are **request-scoped**: no instance at registration, one per request through experimental `controllerFactory` (default `new Controller()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| #19         | Experimental `onCleanup` on the factory context: LIFO, awaited, exactly once, on success and every failure path, before the route handler settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SPEC-003    | Angular DI feasibility: **CONDITIONAL GO** through consumer-owned Angular injectors on the existing seam; no Strata API change ([report](research/analog-di-feasibility.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SC PoC      | Server-component graph PoC: **CONDITIONAL GO**. Server component + transitive server-only deps absent from browser output; child hydrates onto SSR nodes and is interactive; fixture-only, no package change ([report](research/server-component-graph-poc.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SC nav      | Server-component navigation PoC: **CONDITIONAL GO**. Document navigation GO; Angular Router navigation NO-GO (empty surrogate, no server request, silent; no public seam); fixture-only ([report](research/server-component-navigation-poc.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| SC CF       | Server-component PoC on Cloudflare Pages (local Wrangler/workerd): **CONDITIONAL GO**. SC direct load, document navigation, controllers GO; SPEC-003 Angular DI NO-GO (JIT refused) ([report](research/server-component-cloudflare-poc.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC pkg      | Server-component mechanism extracted into the private `@strata-sc/server-components` package (`private: true`, not published, still experimental, document-navigation-only); the fixture consumes it. Client references are explicit `[strataClient]` boundaries. PoC verdicts unchanged ([README](../packages/server-components/README.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SC compose  | Server Component composition (private package, still experimental): ordinary server-only child and grandchild components, nested Server Components, and transitive client-boundary discovery through local `imports`; interactive (event, two-way, host-listener) bindings in server-owned templates fail the build. Dogfooded by Relay (`pnpm test:relay:server-components`) ([README](../packages/server-components/README.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SC protocol | Client boundary protocol v1 (private package, preview, not stable): `[strataClient]` props are validated at runtime on the server (flat plain object; `string`, finite `number`, `boolean`, `null`; `__proto__`/`prototype`/`constructor` rejected; 64 props; 64 KiB UTF-8) and written beside `data-strata-protocol="1"`. The browser preflights every boundary of a Server Component host (protocol, JSON, values, limits, selector, public input names) before creating any island, and rolls back a failed commit. Fixture `/server-component-boundaries`; `pnpm test:server-components` (Node, fail-closed matrix) and `pnpm test:server-components:cloudflare` (positive path) ([README](../packages/server-components/README.md#client-boundary-protocol))                                                                                                                                                                                        |
| SC defer    | Server Components + Angular `@defer` (private package, experimental): `@defer` inside a `[strataClient]` component is Angular's (incremental hydration on interaction and viewport, lazy chunk fetched only on the trigger, event replay, SSR DOM reused); `@defer` in any server-owned template fails the build with a shape-specific diagnostic. Analog 2.7.2 apps need `environments.ssr.define.ngServerMode = "true"` for SSR to honour hydrate triggers. Fixture `/server-component-defer`, Relay rollout island; `pnpm test:server-component-defer` (Node), `pnpm test:server-components:cloudflare` (workerd) ([report](research/server-component-defer-poc.md))                                                                                                                                                                                                                                                                                  |
| SC firewall | Server-only modules (private package, experimental): `import "@strata-sc/server-components/server-only";` is a build-time assertion that the module must never enter the browser graph; barrels re-exporting a marked module inherit it; ordinary imports do not propagate. Illegal direct, dynamic, `@defer`-lazy, barrel, chained-barrel, `?raw` and `?url` browser imports fail real production builds with a Strata diagnostic. Fixture canary, www and Relay dogfood; `pnpm test:server-component-server-only` ([README](../packages/server-components/README.md#server-only-modules))                                                                                                                                                                                                                                                                                                                                                              |
| SC security | Server Component data confidentiality (private package, **no runtime change**): a server-only repository uses a synthetic DATA canary; only a safe verdict and a PUBLIC control cross. The DATA canary is absent from raw SSR HTML, headers, protocol v1 payload, hydrated DOM, public network, browser output, source maps, production errors and build diagnostics on Node and local workerd; present in the server/Worker graphs. Fixture `/server-component-security*`; `pnpm test:server-component-security` ([report](research/server-component-data-security.md))                                                                                                                                                                                                                                                                                                                                                                                 |
| SC failure  | Server Component failure and recovery (private package, buffered SSR + document navigation, **runtime change: one diagnostic only**): six separate cases (server render, serialization, preflight, commit rollback, error after hydration, navigation to a failing document). One Server Component host is one hydration transaction: a failing host is inert with its SSR DOM while sibling hosts hydrate; Angular's per-callback `afterNextRender` handling delivers the one error to `ErrorHandler`, no rethrow, no retry. Server render errors answer HTTP 200 (empty outlet, or a half-rendered component for a template error): the exact current Angular/Analog behaviour, not a success; no supported Strata seam to change it. Streaming unsupported. Fixture `/server-component-failures`, `/server-component-failure/:mode`; `pnpm test:server-component-failures` (Node + workerd) ([report](research/server-component-failure-recovery.md)) |

Current lifecycle facts:

- `@strata-sc/h3` still creates one controller instance per controller at registration and shares it
  across requests. That instance is never a safe place for request state.
- `@strata-sc/analog` creates a controller per request and provides no injector. With the consumer glue
  measured in SPEC-003, controllers resolve application- and request-scoped Angular services with
  `inject()` at construction. Overlapping requests are isolated (barrier-proven), and request
  injectors are destroyed on success, throw and rejection. The application injector is separate
  from Analog's SSR and server-function injectors (no supported seam reaches those), and the Nitro
  bundle then needs `@angular/compiler` declared in `nitro.moduleSideEffects`.
- Server components (experimental, document requests only): the Vite plugin and runtime live in the
  private, unpublished `@strata-sc/server-components` package, consumed by the fixture. The plugin
  sends `@ServerComponent()` modules to generated empty-template surrogates in the `client`
  environment. Only children marked `[strataClient]` are client references; they are hydrated as
  roots from their `ngh` annotations. The plugin finds them transitively: it walks the Server
  Component's template and, through each component's own `imports`, the templates of the unmarked
  local components it renders (ordinary children, grandchildren and nested Server Components,
  all server-owned), stopping at each `[strataClient]` boundary. The outer surrogate owns every
  client reference found. An event, two-way or host-listener binding in a server-owned template,
  a composition cycle, or an ambiguous selector fails the build. Package components are opaque
  (never crawled). This relies on undocumented Angular 22.1.7
  hydration behaviour and on Analog's environment names. Direct load
  and document navigation work; an Angular Router navigation to the route renders the empty
  surrogate without error. Leaving through the router destroys the islands. Checked by
  `pnpm test:server-components` and `pnpm test:server-component-navigation` (in CI).
- Client boundary protocol v1 (preview, not stable), evidence from the Analog fixture's
  `BoundaryProtocolServerComponent` (`/server-component-boundaries`) and unit tests in
  `packages/server-components/src/runtime/*.test.ts`:
  - Runtime value validation: unsupported values (undefined, NaN, ±Infinity, BigInt, functions and
    signals, symbols, arrays, nested objects, Date, Map, Set, RegExp, class instances), reserved
    keys, accessors and symbol keys fail with a Strata error naming the boundary, prop, received
    type and allowed values, before `JSON.stringify` (unit).
  - Limits: 64 props pass and 65 fail; 65 536 UTF-8 bytes pass and 65 537 fail, measured with
    `TextEncoder` and a multibyte case that UTF-16 length would pass (unit).
  - Escaping: `" ' < > &`, `</script><script>…`, U+2028/U+2029, emoji and non-Latin text stay inside
    the Angular-escaped attribute; the island receives the exact strings and
    `globalThis.__STRATA_XSS__` is never set (Node and workerd).
  - Boundary identity is the SSR host element: two islands with the same selector and props are two
    `ComponentRef`s on two hosts with independent state (Node and workerd).
  - Version skew fails closed: a `data-strata-protocol="999"` boundary (also invalid JSON, an
    unknown input, an aliased input under its property name) hydrates nothing in its Server
    Component host, leaves the SSR DOM and interaction inert, logs one Strata error and does not
    reload (Node, Playwright response interception).
  - A commit failure after three islands destroys all three, restores their SSR hosts in place and
    leaves `ApplicationRef.viewCount` at its zero-island baseline (Node).
  - An invalid value at SSR logs the Strata error and never reaches the HTML (no `data-strata-props`
    is written), so the browser refuses that host. Angular reports the binding error to its
    `ErrorHandler` and completes the render: the HTTP status stays 200, owned by Angular/Analog.
- Server Components and Angular `@defer` (fixture `/server-component-defer`, Relay's rollout
  island; [report](research/server-component-defer-poc.md)):
  - Two layers: `StrataIslandHost` hydrates each `[strataClient]` root on load (unchanged, not
    lazy); Angular hydrates each `@defer` block inside that root's own template on its trigger.
  - `hydrate on interaction`: the lazy chunk is requested only by the click, the widget is
    constructed once, one click produces one effect (event replay), and the SSR host, button and
    text nodes are kept (Node, workerd, Relay). `hydrate on viewport`: the lazy chunk is requested
    only when scrolled into view (Node, workerd).
  - Bundle: each deferred dependency is a chunk reached only by dynamic `import()` from the island's
    chunk, never in the static closure of the entry or the island; server parent and server-owned
    child stay absent from the browser.
  - Protocol v1 still gates the island: a tampered version refuses the host, and the deferred chunk
    is never requested even on interaction (Angular then logs a `TypeError` from its replay
    contract, recorded).
  - `@defer` in a server-owned template (root, ordinary child, nested Server Component; any
    trigger, `hydrate never` included, with or without a `[strataClient]` inside) fails the build.
    Measured before the rule: the placeholder is never replaceable, hydrate triggers throw or never
    complete, an island inside is hydrated on load regardless of its trigger, and under
    `hydrate never` it is rendered twice.
  - Analog 2.7.2 defines `ngServerMode` as `false` for the SSR graph of a production build (and
    rewrites only `core.mjs`), so SSR renders hydrate-trigger placeholders until the app sets
    `environments: { ssr: { define: { ngServerMode: "true" } } }` (fixture and Relay do).
- Server-only modules (fixture `src/app/server-component/`, www, Relay;
  [README](../packages/server-components/README.md#server-only-modules)):
  - Assertion: `import "@strata-sc/server-components/server-only";`, an empty package entry (no
    imports, no code). The plugin pre-scans `sourceDir` with the TypeScript AST at `config()`; the
    specifier inside a comment, string or template literal does not mark a module (unit).
  - Re-export taint: `export * from`, `export { X } from` and `export * as X from` propagate the
    restriction upward to a fixpoint (chains and cycles, unit); ordinary imports and
    `export type { … } from` do not. `shared-format.ts`, imported by the marked repository and by
    the `AddToCart` island, is bundled for both graphs.
  - Direct browser import rejected: a temporary `[strataClient]` island importing the marked
    `ProductRepository` fails `vite build` with `[strata] Server-only module entered the browser
graph: src/app/server-component/product-repository.ts` / `Imported from:` the island /
    `Reason:` / fix.
  - Dynamic import rejected: `await import("…/product-repository")` in the island fails the build
    with the island as importer; no lazy browser chunk is emitted. The same holds for a dynamic
    import inside a component loaded by the island's own `@defer` (importer: the lazy component).
  - Re-export/barrel rejected: a barrel re-exporting the repository, and a barrel B → barrel A →
    repository chain, fail the build naming the barrel the browser reached and the full chain.
  - Raw-source import rejected: `server-secret.ts?raw` and `?url` fail the build (query stripped,
    underlying module checked). A query import of a `@ServerComponent()` module now fails the same
    way instead of resolving to its surrogate.
  - No browser output exists after any of these failures; a legal control (Server Component →
    marked repository, island → shared module) builds.
  - Node graph proof: the canary `STRATA_SERVER_ONLY_CANARY_7F3D9A41C2E5` (in the marked
    `server-secret.ts`) is in `dist/ssr` and the Nitro server, absent from `dist/client`,
    `dist/analog/public` and every browser source map; the marked modules are in SSR source maps
    only; the assertion entry is bundled nowhere in the browser; the page renders through the marked
    repository on Nitro `node-server`. The plugin-off control leaks the canary and both modules.
  - workerd graph proof: `pnpm test:server-components:cloudflare` finds the canary in the Worker
    graph reachable from `_worker.js` and not in the public assets; www's marked repository and
    proof module are in its Worker graph and absent from its Pages assets.
  - Dogfood: Relay marks `server-operations-intelligence.ts` and `incident-digest.source.ts`; www
    marks `server-component-facts.repository.ts` and `server-component-proof.ts`. Their gates check
    the assertion in source (AST) and the modules' absence from browser source maps.
  - Not covered: dev server/HMR, aliased or package re-exports in the pre-scan, marked modules
    outside `sourceDir` (rejected only when their assertion import is resolved), data disclosure
    through HTML, errors or caches (R11: covered for synthetic canaries by the SC security entry
    below). Security as a whole is not complete.
- Server Component confidentiality, in three independent layers (fixture `/server-component-security*`,
  [report](research/server-component-data-security.md)):
  - **Module confidentiality** (PR #49, unchanged): the server-only assertion keeps marked modules
    out of the browser graph. It says nothing about the values those modules return.
  - **Data confidentiality**: a value that stays server-owned does not cross merely because a
    Server Component reads or uses it. A synthetic DATA canary used through a server-only repository
    is absent, in raw and encoded forms, from the raw SSR HTML and its comments, inline scripts,
    `ng-state`, `ngh` and `data-strata-*` attributes, every response header, the parsed protocol v1
    payload, the hydrated DOM and text before and after an interaction, cookies and storage, every
    public text/script response, `dist/client`, `dist/analog/public` and every browser source map
    (Node and workerd); it is present in `dist/ssr`, `dist/analog/server` and the Worker graph, and
    changing it in the server output changes the render (it is consumed, not merely present). A
    PUBLIC control passed through `[strataClient]` is present in the SSR HTML, the payload, the
    island's input and the hydrated DOM. A repository instance or a nested object cast into
    `[strataClient]` fails with `StrataBoundaryError` before serialization, the diagnostic naming
    only prop and type. Everything passed through `[strataClient]` is browser-public by definition.
  - **Error-response confidentiality**: a plain `Error`, an `Error` with a secret `cause` and an
    `AggregateError` thrown by the server-only repository leave the public response (status,
    headers, body, browser console and rendered document) without the secret, a stack or an
    absolute path, on Node and workerd. The response is HTTP 200 with an empty outlet
    (owned by Angular/Analog; pinned by the failure gate). The original
    error is only in the server's log, which is the operator surface, not a public one. PR #49's
    illegal-import build diagnostic prints module, importer and reason and never a source line or
    the canary.
  - **Request isolation**: Strata has no request context for Server Components. The only
    request-varying input measured is Angular's route parameter through DI in the routed page: 24
    overlapping requests (A/B) each rendered only their own value on Node and workerd. A Strata-level
    request context does not exist and is **NOT QUALIFIED**. The runtime holds no global payload
    registry, process-wide boundary store or secret cache (source scan and browser global scan);
    module-level state shared between Angular SSR and Nitro (Relay's `processSingleton`) is a
    domain-state workaround, not request or tenant isolation.
  - Not covered: authorization, tenant/cache isolation, origin/CSRF, dev server, a real deployed
    environment, log redaction, third-party error reporters.
- Server Component failure and recovery (fixture `/server-component-failures` and
  `/server-component-failure/:mode`, [report](research/server-component-failure-recovery.md)); buffered SSR and
  document navigation only, Node and local workerd:
  - Server render error (constructor, injected provider, template): the error reaches the server
    `ErrorHandler` once; the response is HTTP 200 with an empty router outlet (construction) or a
    half-rendered component whose boundary host has no `data-strata-*` attribute (template). This is
    the exact current Angular/Analog buffered behaviour, not an ideal or a Strata success response. No
    public seam (`renderApplication` and `BEFORE_APP_SERIALIZED` route errors to `ErrorHandler`; only a
    global rethrowing handler would change the status) exists, so Strata ships no recovery.
  - Serialization error: HTTP 200, one `StrataBoundaryError` on the server, no `data-strata-props` and
    no value in the HTML; the boundary host keeps `data-strata-client` and `data-strata-protocol`. The
    browser refuses it at preflight and hydrates nothing.
  - Preflight and commit failures are per host: B inert with its SSR nodes, A and C hydrated and
    working, exactly one `ErrorHandler` call and one `console.error`, no `pageerror`. Commit failure
    destroys every island that commit created (constructed = destroyed, views = baseline − B's), restores
    the same DOM nodes in place and reports the component's own `Error`. No retry or reload. Stale
    assets (protocol 999 on a host) behave the same; automatic recovery is not implemented.
  - After hydration, a throwing handler is Angular's: reported per click, no Strata intervention.
  - Document navigation into a failing route, Back (a new `back_forward` document, not bfcache) and
    re-entry are fresh lifecycles, one server report each, no stale client state.
  - Runtime: no `ErrorHandler` code was needed (Angular already catches per `afterNextRender` callback
    and does not rethrow). The preflight "invalid JSON" error no longer repeats the JS engine's message,
    which some engines build from the payload.
  - Streaming (Analog `experimental.streaming`) is unsupported and not qualified.
- Cloudflare Workers (local workerd only, nothing deployed): the same fixture built with
  `BUILD_PRESET=cloudflare-pages` passes the server-component, navigation and controller
  assertions under `wrangler pages dev`. The SPEC-003 Angular DI route fails there, because
  workerd refuses Angular's JIT code generation. Checked by
  `pnpm test:server-components:cloudflare` (in CI).
- Not yet verified on the Analog track: a deployed Cloudflare Pages project, abort/timeout cleanup,
  streamed-body lifetimes. (Packed `@strata-sc/analog` consumers and non-GET methods are now covered;
  see the gaps section.)

The first gap bullet of the 2026-09-17 audit below ("No Angular/Analog/Nitro dependency, DI
integration … request API") is superseded by the table above. Its other bullets still stand.

## Audit of 2026-09-17

Inspected on 2026-09-17 at `f258fc3` (`main`, merge of SPEC-001 / PR #4). Initial working tree was clean.
Scope: all tracked source, tests, manifests, build/test/compiler configuration, CI, Changesets,
root documentation and relevant history; dependency resolution inspected in `pnpm-lock.yaml`.
Documentation, packed-consumer fixtures and qualification tooling now exist. No production package
files changed between `9d2635e` and this checkout.

## History

| Commit                         | Actual increment                                                 |
| ------------------------------ | ---------------------------------------------------------------- |
| `fb5038c`                      | OSS workspace/tooling foundation                                 |
| `80341ea`, merged by `61d0959` | Core controller/GET metadata; TypeScript decorator pre-transform |
| `b899c59`, merged by `9d2635e` | Real H3 v2 adapter and integration tests                         |
| `1929957`, merged by `a7fe88c` | Architecture/SDD documentation and SPEC-001                      |
| `f865fca`, merged by `f258fc3` | SPEC-001 tooling, executed evidence and consumer CI invocation   |

The next slice must not recreate H3 execution or packed-consumer tooling: both already exist.

## Implemented contracts

| Area                 | Evidence and limitations                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core exports         | [Public barrel](../packages/core/src/index.ts): `Controller`, `Get`, `Post`, `Put`, `Patch`, `Delete`, `getControllerDefinition`, definition types, `HttpMethod` and `STRATA_VERSION`                                                                                                                                                                           |
| Metadata             | Standard decorator `context.metadata`, private symbol keys, guarded `Symbol.metadata` initialization; frozen route records, definition and route array. Own-property access only: no implicit controller/route inheritance. No H3 or Angular dependency.                                                                                                        |
| Paths                | Missing/empty paths become `/`; leading slash added, repeated slashes collapsed, trailing slash removed. `HttpMethod` was only `"GET"` at this audit; see the gaps section for the current set.                                                                                                                                                                 |
| Adapter exports      | [Public barrel](../packages/h3/src/index.ts): `registerControllers`, `ControllerClass`, `StrataH3ConfigurationError`                                                                                                                                                                                                                                            |
| Execution            | Reads core's public definition, joins paths, calls `app.on`, returns the original H3 instance. Native H3 routes coexist. Sync/async results pass to H3.                                                                                                                                                                                                         |
| Lifecycle            | One no-argument constructor invocation per controller entry per registration call; instance reused by its routes and requests. Methods receive **no request argument**. No DI or request scope.                                                                                                                                                                 |
| Configuration errors | Missing controller metadata and non-callable handlers throw during registration. This is not an atomic registration transaction.                                                                                                                                                                                                                                |
| Runtime dependency   | Manifest `h3: ^2.0.1-rc.1`; lockfile resolves **2.0.1-rc.32**. H3 and core are externalized in adapter build.                                                                                                                                                                                                                                                   |
| Distribution         | ESM-only, `dist` exports, declarations/maps. Changesets versions: core/analog/h3 `0.1.0`. Only core and analog are published, by the manual `publish-packages.yml` under `next`, first publish pending ([ADR-004](adr/004-experimental-npm-distribution.md)); h3 is excluded. `pnpm test:package-consumer` qualifies the packed tarballs with TypeScript 5.9.2. |

The dynamic-route test proves matching `/users/123`; its handler returns a fixed object. It does
**not** prove parameter extraction. No request, body, query or header API is implemented.

## Toolchain and checks

Repository pins pnpm 10.30.1, TypeScript 6.0.3, Vite 8.3.0, Vitest 5.0.1; lockfile resolves
Rolldown 1.2.8. Manifests declare Node `>=22`; CI selects Node 22 and runs lint, typecheck, tests
and build, then `pnpm test:consumer`. That configuration does not certify all Node versions.
The [merge CI run](https://github.com/Andersseen/Strata/actions/runs/35225050803/job/105214360278)
failed at lint (23 unresolved-type errors in adapter source/tests); later steps, including consumer
qualification, were skipped. Public core exports target `dist`, which a fresh checkout has not built
before lint. This is a separate workspace bootstrap issue, not remote reproduction of AC2. Local
`pnpm lint` passes with existing build artifacts. SPEC-002 must make the qualification reachable
from a clean checkout without disabling rules or aliasing package source.

Both packages contain a private `vite-plugin-standard-decorators.ts`. It invokes TypeScript
`transpileModule` with ES2023/ESNext before Vite, excludes dependencies and declaration files,
and only matches IDs ending in `.ts`. It is used by their Vite/Vitest configurations and is not
exported or shipped as a consumer tool. `transpileModule` does not replace type checking.

Earlier pre-SPEC-001 local check: `pnpm exec vitest run` on Node **22.23.0** passed **34 tests in 6 files**
(22 core tests, 12 adapter tests). Existing installed dependencies and built core output were used;
this was not a clean build, tarball installation or deployment test. No production source was
changed to obtain this result.

## SPEC-001: executed, runtime proven, strict type qualification blocked

The [recorded run](research/consumer-compilation.md) used baseline `a7fe88c`, Node 22.23.0,
pnpm 10.30.1, TypeScript 6.0.3, Vite 8.3.0 and H3 2.0.1-rc.32. Its implementation was merged in
[PR #4](https://github.com/Andersseen/Strata/pull/4). Review confirms:

- `tests/consumer/fixture` and `tools/consumer` build/pack both packages, install them outside the
  workspace and use consumer-local tools and public imports. `workspace:*` becomes `0.0.0`; the
  fixture's local-tarball override yields one core copy. This does not prove registry publication.
- Consumer-authored standard decorators compile through `tsc`; emitted JS runs in plain Node.
  Vite SSR bundling of that JS also runs. Both exercise real in-process H3 requests: sync/async
  controller routes, instance binding and a native route. Public metadata and preservation of an
  existing `Symbol.metadata` pass. No listening server or deployment was tested.
- Strict consumer typecheck exits 2: H3's `HTTPError.isError` uses `static override` without the
  ambient `Error.isError` in the fixed lib set (TS4113); H3's root declarations import optional
  `crossws` types even for HTTP-only consumers (TS2307). No diagnostic in this run originates in
  Strata declarations. Strata nevertheless owns qualification of its exposed dependency contract.
- JS was emitted because `noEmitOnError` defaults to false. Runtime success does not make the
  typecheck clean. The consumer does not inherit the workspace's `skipLibCheck: true`.
- Direct stock Vite builds but retains standard decorator syntax; Node rejects it. The reference
  `tsc → JS → Vite → Node` path works. This proves a consumer compilation requirement on the
  measured tuple, not a requirement to publish or reuse Strata's private plugin.
- The report records AC1/AC3–AC8 Pass and AC2 Blocked. Those are stage-level observations, not
  acceptance of the complete spec. Remote execution and exact transitive pinning need correction.

Review found the runner reports **workspace** Rolldown 1.2.8 but does not pin/measure the external
consumer's Rolldown. The retained installation and its npm lock resolve **1.2.9**. Runtime results
remain useful; an exact 1.2.8 consumer claim is unproven. Version assertions and failure ownership
must come from the measured graph/diagnostics, not the runner's hard-coded explanations.

Read-only rechecks in this audit reproduced both diagnostics with consumer-local TS 6.0.3
(`--noEmit --skipLibCheck false`). Adding only `esnext.error` removed TS4113 and left TS2307.
Node 22.23.0 reports `typeof Error.isError === "undefined"`: that lib supplies types, not a runtime
polyfill. Registry/source research and alternatives are in
[H3 consumer type compatibility](research/h3-consumer-type-compatibility.md).

**M1: Blocked, partially proven.** SPEC-001 remains Blocked. SPEC-002 has now been implemented and
executed (below) with a measured no-go; a clean type contract and reproducible remote qualification
are still required. No M2 work is authorized.

## SPEC-002: executed, no eligible candidate found (upstream-blocked)

Implemented and executed against `497a23b` (`main`, TypeScript-first tooling cleanup; no `packages/`
drift from `f258fc3`). Full measured evidence, regenerated by every `pnpm test:consumer:types` run:
[docs/research/consumer-type-closure.md](research/consumer-type-closure.md). Detailed AC-level
evidence is recorded in [SPEC-002's Implementation result](specs/002-h3-consumer-type-closure.md#implementation-result).

- **A** reproduces both historical diagnostics (TS4113 on `HTTPError.isError`, TS2307 on `crossws`)
  exactly, on the H3-only reproduction and the packed Strata consumer alike.
- **B** (`esnext.error`) removes TS4113 only; TS2307 remains. Confirms the lib correction alone is
  insufficient, as predicted.
- **C** (`crossws@0.4.12` declared explicitly) does not close the graph: crossws's own root
  declarations unconditionally import `bun` and `cloudflare:workers`/`@cloudflare/workers-types` from
  internal chunk files, producing new TS2307/TS2552 diagnostics. Declaring the peer makes the measured
  diagnostic count worse, not better.
- **D-node-only** (Bun/Workers type packages installed but not activated in `compilerOptions.types`)
  still fails: crossws's own module resolution for the bare `"bun"` import pulls in `bun-types`
  regardless of `types` filtering, conflicting with Node's own declarations; `cloudflare:workers`
  remains unresolved since that ambient module needs explicit `types` activation. This isolates the
  actual mechanism (ordinary module resolution, not `types` inclusion) behind the leak.
- **D-full-providers** (`types: ["node","bun","@cloudflare/workers-types"]`) is disqualified by
  SPEC-002's stop rule regardless of outcome, and independently fails with 125 diagnostics — mostly
  `@cloudflare/workers-types` redeclaring DOM/Node globals that conflict with the existing libs. A
  genuine double no-go, not merely a policy rejection of an otherwise-clean configuration.
- Every diagnostic across all cases traces to `h3`, `crossws`, `bun-types`/`@types/bun`, or
  `@cloudflare/workers-types` declaration files. Zero diagnostics originated in `@strata-sc/core` or
  `@strata-sc/h3` in any case — reconfirming SPEC-001's finding that Strata's own declarations are clean.
- Negative ambient controls confirm Bun/Workers globals are correctly unresolved under Node-only
  `types` and correctly resolved once activated, independent of any H3 diagnostic.
- The CI clean-checkout lint failure recorded above is fixed by build ordering alone: removing
  `packages/*/dist` and running `pnpm lint` reproduces the exact 23 unresolved-type errors from the
  merge CI run; running `pnpm build` first resolves it. `.github/workflows/ci.yml` now builds before
  lint/typecheck and runs `pnpm test:consumer:types` before the existing `pnpm test:consumer` gate.

**Verdict: upstream-blocked.** No candidate satisfies SPEC-002's promotion rules. `pnpm test:consumer`
(SPEC-001's required gate) is unmodified and remains failing on AC2, as required; no promotion was
applied to its fixture. SPEC-001/M1 remain Blocked. Astra owns acceptance of this disposition and any
further M1 direction (upstream issue, alternate closure hypothesis, or continued block).

## Gaps and review findings

- No Angular/Analog/Nitro dependency, DI integration, request API, validation,
  guards/interceptors, logging contract, component compiler, navigation protocol or deployment fixture.
- Packed-consumer runtime tests exist; strict installed-package types are blocked. No browser/e2e
  tests, browser bundle assertions or Cloudflare execution.
- Resolved: metadata is class-local (own-property reads/writes). An undecorated subclass has no
  definition; a decorated subclass gets only its own routes; siblings, parents and overrides stay
  isolated. Every HTTP route decorator rejects static, private and symbol-named methods at class definition. Covered by
  core, Analog and packed-consumer (TypeScript 5.9.2) tests. Explicit controller inheritance is not
  supported.
- Resolved (Analog): `registerControllers()` preflights the whole batch before any `router.add()`, so a
  configuration error registers nothing and reserves nothing. A second Strata route with the same
  method + final path on one router fails, within a call or across calls; non-overlapping repeated
  calls and separate routers are fine. Ownership lives in an adapter-local `WeakMap` per router.
- Open: a `router.add()` failure mid-commit propagates and cannot be rolled back (earlier routes stay);
  duplicates against native Nitro routes are not detected; `@strata-sc/h3` keeps the old per-controller
  registration; constructor failures are not specified.
- Resolved (Core + Analog): `HttpMethod` is `"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`, with public
  `Get`, `Post`, `Put`, `Patch` and `Delete` decorators built on one private core primitive (same path
  normalization, class-local metadata, declaration order, frozen records and member restrictions;
  errors name the decorator used). `@strata-sc/analog` maps every method exhaustively to Nitro's
  router and runs all of them through the same planning, duplicate check (method + final path) and
  request invocation path. Verified on H3 v1 unit tests, the Analog fixture (dev and production),
  Wrangler/workerd (`pnpm test:server-components:cloudflare`) and the packed TypeScript 5.9.2
  consumer. The private `@strata-sc/h3` routes all five methods on H3 v2 (internal tests only).
  `HEAD`, `OPTIONS` and other methods have no decorator.
- Resolved (Analog, workerd): `StrataAnalogRequest` body readers failed under Nitro's Cloudflare presets,
  which attach the payload to a non-iterable mock Node request (`req.body`). They now read an attached
  body first, like H3 v1's `readRawBody`; POST/PATCH JSON bodies are asserted under Wrangler.
- Handler exceptions, `Response`/stream passthrough and cancellation lack dedicated Strata tests.

These remain inputs to M1/M3, not permission for Astra to implement fixes. SPEC-002 addresses the
consumer type-contract blocker; it does not declare the remaining primitive contracts stable.
