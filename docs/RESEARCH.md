# Ecosystem research

Retrieved 2026-09-17. These are primary sources and design implications, **not executed Strata
integration results**. Online documentation and `main` branches are mutable and returned differing
patch snapshots. Pin released artifacts and source commits in each subsequent spike. Direct npm
registry verification was unavailable in this environment; no npm `latest` claim is made here.

## H3 and Nitro

H3's [migration guide](https://h3.dev/migration) documents a v1-to-v2 transition: the v2 `H3` class
integrates routing, and request/response/error APIs change. The site still labels v2 beta, while
the [maintainer release feed](https://github.com/h3js/h3/releases) lists `v2.0.1-rc.32` at the top,
dated September 14; Strata's lockfile resolves that version. Treat it as prerelease; a GitHub
“Latest” badge does not establish npm dist-tags or stability.

The current experimental adapter already targets v2. Supporting v1 is a separate interoperability
decision, not changing an import or widening a type. Encapsulate registration, event conversion,
response/error translation and any version bridge in `@strata/h3`.

Analog's [platform manifest](https://github.com/analogjs/analog/blob/main/packages/platform/package.json)
declares `nitropack ^2.13.1`; the
[Nitro v2 manifest](https://github.com/nitrojs/nitro/blob/v2/package.json), versioned `2.13.4` in
the retrieved source, declares H3 `^1.15.11`.
The [Nitro release feed](https://github.com/nitrojs/nitro/releases) also describes a newer H3 v2 line.
**Inference:** “supports H3 v2” does not imply “plugs into Analog's Nitro server.” A pinned Analog
fixture must establish its actual dependency graph and supported mounting API.

Strata commit `b899c59` records why it avoided `h3@2.0.0`; that historical commit statement is not
independent registry verification. Preserve the tested lockfile baseline rather than selecting a
version from its name or a stale banner.

## Angular rendering and compilation

[Angular SSR](https://angular.dev/guide/ssr) provides server, client and prerender modes, request
tokens and server rendering integration. These are rendering capabilities; they do not establish a
server-exclusive component graph. Analog has its own runtime integration, so Angular CLI server
entry points cannot simply be assumed to be Analog extension points.

[Incremental hydration](https://angular.dev/guide/incremental-hydration) uses `@defer` hydration
triggers. `hydrate never` applies to initial hydration, suppresses nested hydration and still allows
dependency fetching on subsequent client rendering. **Inference:** it neither proves module
exclusion nor supplies the required interactive child boundary for a server-only parent.

[Deferred loading](https://angular.dev/guide/templates/defer) distinguishes ordinary SSR placeholder
behavior from hydration-triggered rendering of deferred content. Its HMR behavior also differs
from production. Reuse Angular primitives where they fit; test production builds and do not infer
lazy-loading or boundary guarantees from development behavior.

[Hydration requirements](https://angular.dev/guide/hydration) constrain server/client DOM matching
and direct DOM manipulation. **Inference:** inserting an HTML subtree and calling it “hydrated” is
not a proven Angular navigation protocol. Component creation alone does not prove DOM reuse either.

The [compatibility table](https://angular.dev/reference/versions) currently lists Angular 22.0.x
with TypeScript `>=6.0.0 <6.1.0` and Node `^22.22.3 || ^24.15.0 || ^26.0.0`; Angular 21.x requires
TypeScript below 6. The retrieved page's footer advertises a newer Angular patch than the table
row. Use the published target version's own constraints; do not extrapolate support to all 22.x.

## Angular DI and Analog server functions

[`runInInjectionContext`](https://angular.dev/api/core/runInInjectionContext) permits synchronous
`inject()` calls in its stack frame; it does not preserve that capability across `await`.
[`createEnvironmentInjector`](https://angular.dev/api/core/createEnvironmentInjector) is a public
building block for explicit provider hierarchies. Neither API connects an H3 handler to an Analog
request automatically. Request ownership, parent lifetime and destruction still need experiments.

Analog's [server-function documentation](https://analogjs.org/docs/features/data-fetching/server-functions)
describes `serverFn` in `.server.ts`, Standard Schema validation, client resource/mutation helpers,
SSR execution in the render's request injector, hydration result transfer, and functional
interceptors. It describes server configuration bootstrap and request tokens while withholding the
raw H3 event. This is useful prior art, not proof of a public injector hook for arbitrary controllers.
Confirm these documented APIs exist in the exact released package chosen for a fixture.

Strata will leave internal RPC to those functions. A server-function transform excludes an operation
module; it does not establish that an Angular component's compiled template and implementation can
be split around interactive descendants.

## Analog, Vite and decorators

[Analog SSR](https://analogjs.org/docs/features/server/server-side-rendering) is enabled by default
and configured through its Vite platform plugin and Nitro route rules.
[Analog API routes](https://analogjs.org/docs/features/api/overview) retain native H3 handlers and
also document schema validation. Avoid rebuilding these for simple endpoints.

The retrieved [Analog Angular plugin manifest](https://github.com/analogjs/analog/blob/main/packages/vite-plugin-angular/package.json)
declares Vite 6/7/8 peers and Angular build peers through 22. These broad ranges do not prove Strata's
transform ordering works. [Vite's environment plugin API](https://vite.dev/guide/api-environment-plugins)
offers environment-aware transforms and state; it is a candidate tool, not a chosen compiler design.

[TypeScript's standard decorator semantics](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html)
differ from legacy decorators and do not provide parameter decorators or `emitDecoratorMetadata`
compatibility. [Decorator metadata support](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html)
explains `context.metadata`/`Symbol.metadata`. Strata already uses this model.

Two distinct proofs are required: compilation of Strata's own packages, and compilation of
consumer-authored controllers/components. A further unknown is coexistence of standard Strata
decorators and Angular AOT processing on the same class. The current generic TypeScript pre-pass
must not be assumed safe before Angular template analysis. No public compiler strategy is selected.

## Deployment and validation

[Analog deployment](https://analogjs.org/docs/features/deployment/overview) defaults to a Node
server. Its [provider guide](https://analogjs.org/docs/features/deployment/providers) documents the
`cloudflare-pages` build preset. Current [Nitro Cloudflare docs](https://nitro.build/deploy/providers/cloudflare)
describe Workers and Pages shapes under newer preset spellings and favor Workers. These are
version-specific paths, not interchangeable configuration recipes.

Cloudflare's [Node compatibility documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
distinguishes native implementations, polyfills and non-functional stubs. `nodejs_compat` does not
prove a server dependency works. Pin compatibility date/flags and test the actual deployment shape.

[Standard Schema](https://standardschema.dev/) provides a validator interoperability contract.
Strata's future HTTP validation layer should consume that contract while specifying transport
parsing, error mapping and execution order itself; no specific validation library is prescribed.

## Consequences for the next decisions

1. Establish consumer compilation evidence before creating a public compiler package.
2. Resolve the H3-major/Analog mounting mismatch and request-injector access with pinned fixtures.
3. Attempt strict component graph separation and interactive child hydration early, before broad
   HTTP API expansion. A compiler integration failure is a 1.0 blocker.
4. Compare document navigation with a router payload protocol experimentally. Neither is selected.
5. Refresh this research when drafting those specs; record package versions, source commits and
   reproducible evidence instead of treating mutable documentation as a compatibility matrix.
