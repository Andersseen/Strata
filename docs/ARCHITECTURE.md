# Architecture

Status: architectural constraints accepted; integrations and component mechanisms below are
unproven until their roadmap gates pass. [STATE](STATE.md) owns implemented behavior and
[RESEARCH](RESEARCH.md) owns upstream observations.

## Layers and ownership

```text
Angular / Analog application
  ├─ simple API routes ───────────────────────────────┐
  ├─ internal RPC → Analog server functions           │
  └─ structured HTTP / server-only UI → Strata        │
                                          ↓          ↓
                                         H3 ← Nitro integration
                                          ↓
                                  Node / Cloudflare runtime
```

This is responsibility layering, not a claim that every call traverses a Strata runtime. Nitro
builds and hosts the server; Analog owns application routing/rendering. Native HTTP and internal
RPC remain available independently.

| Package                                            | Responsibility                                                                                                        | Must not own                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `@strata/core` — exists                            | Runtime-independent controller/route metadata and future justified domain contracts                                   | H3 events, Angular injectors, Nitro lifecycle, Vite transforms, HTTP server |
| `@strata/h3` — exists                              | Route registration, HTTP execution; future H3 request/response/error mapping and version interoperability             | Angular compiler, app bootstrap, RPC duplication                            |
| `@strata/analog` — candidate                       | Concrete Analog registration, SSR/request lifecycle and build integration through supported extension points          | A replacement Analog router or an independent app provider registry         |
| `@strata/compiler` / `@strata/vite` — candidates   | Graph analysis/transformation versus Vite orchestration, only if those responsibilities warrant separate distribution | Generic framework runtime; packages created merely for symmetry             |
| `@strata/angular` / `@strata/testing` — candidates | Reusable Angular runtime boundaries / consumer testing helpers when demonstrated                                      | A second DI container; re-export-only scaffolding                           |

Adapter packages may depend on core, never the reverse. Angular-related dependencies belong in
an integration boundary, not the existing metadata package. Decide dependency versus peer ranges
when testing installed packages; today's dependency declarations are not a final release policy.

## Package compilation, consumer compilation and declaration compatibility

These are distinct boundaries. The private TypeScript pre-transform builds/tests Strata packages;
it is not shipped as a consumer compiler. SPEC-001 independently demonstrated consumer-written
standard decorators through `tsc → JavaScript → Vite SSR → Node`, including metadata initialization
and real H3 requests. Stock Vite 8.3.0 directly on that TypeScript retained decorator syntax and
Node 22.23.0 rejected it. See [measured results](research/consumer-compilation.md) and
[review limits](STATE.md), including consumer Rolldown drift.

Consequently, consumers need an explicit lowering stage for this measured path. Neither a public
`@strata/compiler`/`@strata/vite` package nor the safety of the private transform with Angular AOT
has been established. Public compiler packaging remains open; M2 owns integration experiments.

Runtime evidence does not qualify declarations. The adapter's public `H3` signature exposes H3's
declaration graph: its `Error.isError` lib assumption and optional `crossws` import currently block
strict consumers. Keep this requirement at the adapter/consumer compatibility boundary, never in
core metadata or a decorator transform. A `lib` addition changes ambient type availability without
polyfilling Node. Peer optionality at installation does not make a root declaration import optional.
[SPEC-002](specs/002-h3-consumer-type-closure.md) will qualify or reject a narrow published dependency
closure; no H3 major change, fork, ambient shim or permanent dependency policy is selected here.

## HTTP domain

H3 remains the HTTP authority. Future Strata request contracts should prefer `Request`, `Response`,
`Headers`, `URL` and cancellation signals. H3-specific escape hatches belong to the H3 adapter;
native handlers must continue to coexist without wrapping every endpoint in a controller.

Before HTTP API stabilization, one request-input spike must compare:

| Option                              | What must be evaluated                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Explicit handler context argument   | Discoverability, type inference, zero-argument compatibility, tests and runtime independence |
| Functional extractors               | Explicit context ownership, params/query multiplicity, body consumption and composability    |
| Injected request primitives         | Angular request injector availability, synchronous resolution, lifetime and non-Angular use  |
| Method/class decorator alternatives | Explicit metadata without legacy parameter decorators; avoid encoding an entire schema DSL   |

Do not introduce `@Param()`, `@Body()` or `@Query()` parameter decorators. The input spec must
decide decoding, missing values, repeated query keys, one-shot body reads, content types, size
limits and Standard Schema sync/async validation before freezing signatures.

A later execution contract must define the order of context creation, authorization guards,
validation, handler execution, interceptor unwind/error mapping and disposal, including
short-circuiting and cancellation. Logging must carry request correlation without exporting
secrets. Reuse H3 capabilities; do not invent an RxJS pipeline to obtain these semantics.

## DI feasibility and ownership

Angular DI is the preferred mechanism, subject to proof. The spike must trace the exact Analog
bootstrap, per-request injector construction and destruction for SSR and server-function dispatch,
then establish whether a supported hook exists for controllers. Inspect pinned upstream source
as well as public documentation; private access must be reported as a compatibility dependency.

The experiment compares a documented Analog injector hook, if available, with explicit Angular
environment injectors owned by Strata's integration. Creating an independent injector must not
silently produce a second application configuration or duplicate service instances.

Proof obligations:

- Define process/application, render/request and controller instance lifetimes. Angular
  `providedIn: 'root'` alone does not establish a process-wide singleton in an SSR runtime.
- Resolve dependencies during constructor/field initialization or synchronous invocation; retain
  resolved values across `await`. Do not promise post-`await` ambient `inject()`.
- Compare service identity across controller, SSR, server function and prospective server component
  in the same request; prove isolation across overlapping users/tenants and no retained request data.
- Specify who destroys injectors on success, error, timeout and abort, and how tests override providers.
- Test Node and Workers without assuming Node async-local storage is the solution.

`@strata/h3` still shares one controller instance across requests; that placeholder is never a safe
location for request state. `@strata/analog` creates a new controller instance per request through
an experimental `controllerFactory` seam (default `new Controller()`); the seam can wrap
construction in an externally owned injection context but provides no injector itself. A fixture-owned
experiment ([Analog report](./research/analog-integration-baseline.md)) builds controllers inside a
per-request child of an explicitly created `Injector` and destroys it through Nitro hooks; it is not
the SSR application's injector, and `@strata/analog` has no release hook yet. No DI public
API or ADR is selected until this experiment concludes.

## Strict Server Component boundary

SSR means a component renders on the server; its implementation may also ship to the browser.
A Server Component means its implementation belongs exclusively to the server graph. The
provisional name `@ServerComponent` expresses intent, not a committed decorator signature.

| Module                                                                           | Server graph                                         | Browser graph |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| `ProductDetails` server implementation, including compiled server template logic | Required                                             | Forbidden     |
| `DatabaseService`, ORM and transitive server dependencies                        | Required when used                                   | Forbidden     |
| `AddToCartComponent` normal Angular interactive boundary                         | May render on server and be referenced as a boundary | Required      |
| Explicit serializable public props / safe boundary identity                      | Produced by server                                   | Allowed       |

The browser may receive rendered HTML and a separate boundary representation. A generated client
surrogate, if needed, must not contain or import the server implementation. Type-only references
must erase; runtime imports and re-exports must be checked transitively. Templates, lazy chunks,
public source maps and preload manifests count as browser output.

`hydrate never`, `isPlatformServer`, filename conventions and tree shaking alone cannot establish
this guarantee. The compiler experiment must show how Angular's compiled view/hydration metadata
can retain an interactive descendant without shipping its server parent. Failure to find a
supported approach is a valid no-go result; CSR recreation is not equivalent to successful hydration.

### Boundary data and security

The eventual serialization contract must enumerate permitted values, encoding/versioning, size
limits and rejection behavior. Start evaluation with explicit plain-data props; do not serialize
service instances, closures, arbitrary class prototypes, credentials or provider graphs. Rich
values such as dates and big integers require an explicit tested decision.

Graph exclusion prevents code delivery; it does not prevent leaking data through HTML, props,
transfer state, error bodies or logs. Tests must cover both. Request authorization also applies to
direct subtree/payload requests if such endpoints exist. User-specific responses and cached payloads
must be isolated by identity/tenant and invalidation policy. Client-supplied boundary identifiers
must not resolve arbitrary modules or invoke arbitrary server code.

Before 1.0 define safe error output for initial render failures, failure after headers/streaming
begin, serialization rejection, missing/stale boundary IDs, navigation failure and hydration
mismatch. If streaming is not supported, document and test buffered rendering; do not imply a
streaming protocol. Production failures must not expose stacks, source paths or secrets.

## Navigation and Angular coexistence

Initial SSR is the first proof, not a complete rendering architecture. M2 identifies viability;
M4 chooses and specifies one production navigation strategy using measured fixtures:

| Candidate                                            | Required proof                                                                                                                                       | Cost to evaluate                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Full document navigation for server-component routes | Links, programmatic navigation, redirects, deep links and history consistently request server documents; interactive boundaries hydrate on each load | State reset, transition latency, scroll/focus and mixed CSR routes      |
| Client router plus server subtree/payload            | Stable payload identity/versioning, Angular-supported attach/hydrate lifecycle, cleanup, cancellation, history and error recovery                    | Framework coupling, cache/auth/serialization surface and retained state |

Document navigation is eligible for 1.0 only if explicitly selected, automated and acceptable to the
real consumer. It is not an excuse to leave normal router links rendering missing server code.
Do not copy React Flight, invent Suspense, inject arbitrary DOM into Angular-owned views or ship the
server component as a CSR fallback. If neither strategy is safe, 1.0 remains blocked.

Test ordinary hydration, incremental hydration, nested `@defer`, event replay, projected/nested
interactive children and mixed conventional routes. Enumerate unsupported compositions with clear
build diagnostics. No public boundary API is frozen before those constraints are understood.
