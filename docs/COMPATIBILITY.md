# Compatibility policy

Policy date: 2026-09-17. There is **no production support matrix yet**. Distinguish manifest ranges,
locally exercised versions, researched candidates and qualified release combinations.

## Baseline and target selection

| Layer           | Evidence today                                                                                                                     | Initial qualification policy                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node            | Manifests `>=22`; CI configured for 22; local tests on 22.23.0                                                                     | Initially qualify Node 22 at a concrete patch satisfying all consumer engines. Reassess maintained Node lines before RC; `>=22` is not a promise of every future major.                                                                                                    |
| H3              | Adapter range `^2.0.1-rc.1`, lock/consumer 2.0.1-rc.32; runtime passes, strict types blocked                                       | Initial standalone adapter baseline is the locked v2 RC. Pin exact test resolutions; no v1 claim. Resolve Analog mismatch at M2.                                                                                                                                           |
| Angular         | Fixture only: 22.1.7 (core/compiler/platform-server), `@angular/build` 22.1.8; no support claim                                    | First investigate a published Angular 22 tuple compatible with TS 6.0.3; verify exact compiler/SSR/core versions together. No support claim yet.                                                                                                                           |
| Analog          | Fixture only: platform and Angular Vite plugins 2.7.2, router 2.8.1; dev + `node-server` production measured                       | Pin a coherent released platform/router/Angular-plugin/Nitro-plugin set in M2. Verify required server-function APIs exist; mutable `main` is not a release.                                                                                                                |
| Nitro           | Fixture only: nitropack 2.13.4 on H3 1.15.11, as Analog resolves it                                                                | Test the version Analog actually resolves. Do not substitute Nitro 3 documentation or config without a migration experiment.                                                                                                                                               |
| TypeScript      | 6.0.3 in repository and isolated consumer; explicit libs omit `esnext.error`                                                       | M1 baseline 6.0.3; consumer compiler must satisfy Angular's exact peer constraints. No assumption that an Angular 21 app accepts it.                                                                                                                                       |
| Vite / Rolldown | Vite 8.3.0; workspace Rolldown 1.2.8, retained consumer 1.2.9                                                                      | Qualify dev and production builds on the pinned tuple; broad upstream peers do not validate transform order.                                                                                                                                                               |
| Cloudflare      | Analog controller HTTP contract passes on local Pages/workerd with Nitro cloudflare-pages; no deployment                           | Pin workerd/Wrangler, compatibility date, flags and Nitro preset. Local workerd HTTP evidence does not qualify a deployment. `Request.signal` is available in native Workers only with `enable_request_signal`, but the pinned Nitro adapter does not expose it to Strata. |
| Browser         | Chromium via Playwright 1.62.1 on Node and local workerd for the locked Angular 22.2.3 fixture tuple; no production browser policy | Record the exact browser binary/version and adopt the selected Angular version's browser policy in M4/M5. Local Chromium fixture checks do not establish a supported browser matrix.                                                                                       |

The 0.11.0 Server Components candidate introduces per-host browser budgets of 128 owned boundaries
and 1 MiB aggregate serialized payload UTF-8. They do not alter protocol v1/v2 or server writer
limits. These candidate limits are not yet qualified across the compatibility matrix; see the
[hydration budget evidence](research/server-component-hydration-budgets-v011.md).

The 0.12.0 candidate widens `provideClientReferences` additively: entries may be component types
(unchanged) or `{ type, expectedSelector }`. Hand-written arrays of types keep working, with the
runtime checks that need no descriptor (component metadata present, no selector conflict). It uses
only public Angular `reflectComponentType`; see the
[reference integrity report](research/server-component-reference-integrity-v012.md).

The 0.13.0 test-only follow-up (with an empty Changeset and no version bump) exercises one actual browser `reference` refusal (an unregistered
boundary selector) on Node and local workerd, plus the existing packed consumer. It makes no new
Angular, Vite, browser or deployment support claim. Descriptor negatives and installed-package
reference conflicts remain unqualified; see the
[browser integrity report](research/server-component-browser-integrity-v014.md).

Upstream constraints and source links are in [RESEARCH](RESEARCH.md). A supported tuple must include
all these layers together, the Strata candidate digest and the fixture lockfile. Individual compatible
ranges do not establish that their cross-product is supported.

The Analog 0.10.0 candidate adds `readValidatedForm()` without changing the dependency tuple or adding a
runtime peer. Its local Node production, Vite dev and local workerd checks use the locked Analog 2.7.2 /
Nitro 2.13.4 / H3 1.15.11 tuple and Wrangler 4.135.0. This remains fixture evidence, not a production
support matrix or a deployed Cloudflare claim; the packed npm consumer passes, while hosted CI is pending
([report](research/analog-validated-forms-v010.md)).

Server Component boundary protocol v1 and v2 remain experimental, even when the package manifest
supports the listed Angular, TypeScript and Vite peer ranges. V1 carries flat primitives; v2 carries
bounded nested JSON data. The documented Node and local workerd rehearsals are evidence for those
specific fixture tuples, not a production support matrix or a 1.0 guarantee.

The 0.10.0 candidate's optional host observation provider adds no peer range. Its event is browser-side
and uses the application's Angular injector. Qualification remains tied to the lockfile tuple and the
specific Node, Analog dev, local workerd, and packed-consumer evidence in the
[observation report](research/server-component-hydration-observability-v010.md); it does not establish
a broader compatibility matrix.

External Angular package islands add no new peer range. The fixture is intended to use the actual
locked tuple (core/compiler 22.1.7, common 22.2.3, platform-browser 22.2.3, platform-server 22.2.2,
router 22.2.2, Analog Router 2.8.1, Vite 8.3.0 and TypeScript 6.0.3, with a 5.9.2 declaration
check). The independent library partial compile succeeded locally, but the isolated npm install
failed before AOT linking; package-island support is therefore **not qualified** yet. See the
[package-island report](research/server-component-package-islands.md).

_Update (2026-10-22):_ the sentence above records the first, failed install attempt. The installed-package
shape was later qualified by the packed consumer (independently partial-compiled library, AOT linking in the
Node and workerd builds, SSR and hydration), shipped in 0.4.0 and has gated every pull request since. It
remains bounded to that package shape.

Server-only module resolution (0.6 candidate) adds no peer range. It reads Vite's resolved
`resolve.alias` (Vite >= 8.3.0, the existing peer) and parses the app's tsconfig with the
`typescript` peer (5.9 or 6.x, `ts.resolveModuleName` in bundler mode); it does not touch Angular
private APIs. The packed consumer checks the declarations under TypeScript 6.0.3 and 5.9.2 with
`strict` and `skipLibCheck: false`. See [the report](research/server-component-graph-security-v06.md).
The dependency-optimizer firewall (0.9) relies on `optimizeDeps.rolldownOptions.plugins` and Vite's public dev error
middleware chain, verified on Vite 8.3.0 with Rolldown 1.2.8 ([report](research/server-component-optimized-dependency-firewall-v09.md)).

The optional `@strata-sc/server-components/navigation` entry adds no new peer range: it uses the
public `Router`, `UrlSerializer`, `ActivatedRoute`, `Location` and `DOCUMENT` APIs of the same
`@angular/router`/`@angular/common` tuple. It is Angular partial-compiled and linked by Analog's
build optimizer; the Vite plugin pre-bundles it for `vite` dev when the app resolves
`@angular/router`. It assumes a path-based location strategy (a hash strategy cannot render
Server Components); an absolute `APP_BASE_HREF` on another origin is rejected. See the
[document-navigation report](research/server-component-document-navigation-v04.md).

## Current M1 consumer contract: experimental and blocked

[SPEC-001](specs/001-packed-consumer-compilation.md) proves the external package/runtime path,
not a clean strict type contract. Its TypeScript 6.0.3 / NodeNext / ES2023 consumer, with libs
`ES2023`, `DOM`, `DOM.Iterable`, `esnext.decorators` and Node types, fails in H3 rc.32 declarations.
Workspace `skipLibCheck: true` is not the consumer policy; the installed-package gate must check
all reachable declarations without suppression.

The [current review](research/h3-consumer-type-compatibility.md) verified that H3 npm `latest` is
still rc.32 and no later inspected code change fixes this. TypeScript npm `latest` is 7.0.2, but
Strata remains on 6.0.3: upgrading the compiler is not an established remedy.

- Adding `esnext.error` removes the H3 override error in a measured TS 6.0.3 probe, but does not
  resolve crossws. It is an eligible **new experimental lib requirement**, not an accepted change
  to the original SPEC-001 result. It supplies ambient types, not Node runtime implementation.
- H3's optional crossws peer leaks into the mandatory root declaration graph. crossws 0.4.12 in
  turn exposes platform adapter types. Neither declaring a peer nor adding a consumer devDependency
  proves that the graph is closed. Do not impose Bun/Workers ambient environments on a Node GET
  consumer to call it qualified.
- [SPEC-002](specs/002-h3-consumer-type-closure.md) fixes the candidate versions and go/no-go rules.
  It may qualify an explicit temporary consumer recipe; it does not change shipped peer/dependency
  policy. No clean recipe means an upstream reproduction and continued M1 blocking, not M2 work.
- **SPEC-002 executed: measured no-go.** Declaring `crossws@0.4.12` as an explicit dependency (case C)
  does not close the graph — crossws's own root declarations unconditionally import `bun` and
  `cloudflare:workers`/`@cloudflare/workers-types` from internal chunk files, regardless of whether the
  HTTP-only consumer ever touches WebSockets. Installing Bun/Workers type providers without activating
  them (case D-node-only) still fails, because crossws's `"bun"` import is resolved by ordinary module
  resolution, not by TypeScript's `types` filtering. Activating those providers (case D-full-providers)
  is disqualified by policy for a Node-only consumer regardless of outcome, and independently produces
  125 diagnostics from `@cloudflare/workers-types` redeclaring DOM/Node globals. See
  [measured evidence](research/consumer-type-closure.md) and
  [SPEC-002's implementation result](specs/002-h3-consumer-type-closure.md#implementation-result).
- Pin and report actual consumer transitive versions. SPEC-001's workspace Rolldown value does
  not establish its isolated consumer version. Clean-checkout CI must reach the qualification step.

A compatibility claim needs **both** zero strict consumer diagnostics and successful runtime output
on the same measured tuple. Do not patch dependency declarations, add ambient stubs, cast away the
H3 boundary or set `skipLibCheck` to satisfy that claim. A release upgrade or declaration repair
must be independently qualified before changing this temporary blocked disposition.

## H3 transition

[ADR-002](adr/002-core-and-h3-target.md) preserves the existing v2 experiment. The adapter encapsulates
version-sensitive routing, events, response/error mapping and any bridge; core remains independent.

M2 must compare a dedicated v1 execution path, a tested Web Request/Response bridge and a supported
upstream runtime upgrade. Explicitly test repeated headers/cookies, streaming if supported (the 0.7.0 evidence qualifies the Nitro 2 /
H3 v1 Node and local-workerd behaviour of `streamResponse()` only; H3 v2 is not covered), status,
base paths, context ownership, abort and error behavior. Never cast an H3 v1 app/event into v2 types.

Support more than one major only if a real consumer needs it and each path has its own CI fixtures,
documented API boundary, maintained dependency floor and accountable maintenance. Otherwise choose
one qualified integration target and document its limits. Reject duplicate runtime packages or
peer conflicts rather than hiding them behind overrides. An override is an experiment, not support.

No new API range may be claimed merely because pnpm resolves it. Review advisories and upstream
release notes before selecting each exact candidate, particularly prereleases; the existing wide RC
range is not a security or compatibility certification. Production eligibility of an upstream
prerelease requires an explicit release decision and full evidence, never automatic promotion.

## HTTP routing boundary assumptions

The `apiBoundary` option of `@strata-sc/analog` depends on four behaviours of the pinned H3 v1 router
that Nitro 2.13.4 mounts (h3 1.15.11, radix3 1.1.2): a handler registered without a method serves every method; a request that finds a
route without a handler for its method falls through to the next less specific route that has one;
`/<prefix>/**` does not match `<prefix>` itself; and the router does not backtrack out of a static
branch. The first two are required; the last two are tolerated either way, so a router upgrade must be
re-qualified rather than assumed. Strata declares no H3 or Nitro type and adds no dependency for this.
The H3 v2 transition is not qualified for the boundary. See the [qualification report](research/analog-http-routing-v06.md).

## Request observation assumptions

`onRequestSettled` needs no Nitro or H3 type and adds no dependency. It relies on `globalThis.performance.now()`
(Node and workerd) and on the existing `streamResponse()` ownership: a stream is reported only when its body
completes, fails or is cancelled, and the pinned Nitro 2.13.4 / h3 1.15.11 adapters do not deliver client
disconnect to the body. Cloudflare Workers advance the clock only across I/O. Qualified on the tuple of the
[report](research/analog-request-observability-v08.md) (Nitro Node, Vite dev, local workerd; not a deployed Pages
project).

`validateHeaders` (0.9 candidate) reads the same normalized `Headers` on Nitro Node, Vite dev and local workerd: lowercase
names, duplicates combined with `", "`. Qualified locally on that tuple, not on a deployed Pages project
([report](research/analog-header-validation-v09.md)).

## Deployment skew (Server Components 0.8)

The build identity depends only on Vite `define` reaching every environment of one `vite build` and on the
runtime being bundled into the SSR graph (`ssr.noExternal`, already required). Qualified on the packed
consumer tuple Angular 22.2.3, Analog 2.7.2, Nitro 2.13.4, Vite 8.3.0, TypeScript 6.0.3, Wrangler 4.135.0
(Nitro Node and local workerd). Split builds must pass the same value to every part. A deployed Cloudflare
Pages run and CDN cache semantics are not qualified. See the
[report](research/server-component-deployment-skew-v08.md).

## Deployment scope

Required qualification targets are a supported Node server and Cloudflare Workers execution through
the selected Analog/Nitro deployment path. The experiment must distinguish standalone module Worker
from Pages Functions/advanced Worker output; a Pages deployment does not also certify a standalone
Worker preset. Record the chosen shape prominently and validate a standalone Worker path if it is
claimed. At least one actual Cloudflare deployment of the complete SSR/component path is mandatory.

Netlify/Vercel serverless and static prerender output are relevant Analog deployment shapes but not
additional initial support promises. Static output alone cannot demonstrate request-scoped server
services. Node-only libraries in application services must be identified and excluded from edge
examples; dependencies cannot use `nodejs_compat` as an untested portability claim.

## Release and maintenance rules

Before 1.0, experimental breaking changes need a Changeset when package behavior changes, an
explicit migration note and updated fixtures. Mark experimental APIs in documentation. A passing
spike does not freeze a public contract.

For 1.0, publish tested peer/engine ranges, one minimal qualified tuple per runtime and any tested
range endpoints. A version outside them is unqualified, not implicitly supported. Run the matrix
on relevant PRs and dependency updates, and retain frozen-lockfile candidate checks. Add further
majors only with demonstrated demand and CI capacity.

After 1.0, use SemVer: removal or incompatible behavior/support changes require a major release;
deprecations include migration guidance. Security fixes may narrow unsafe dependency versions,
with a documented impact and replacement tuple. Maintainers own support-window announcements and
must revalidate when frameworks retire a supported line. Do not promise a support duration without
the ability to maintain it.

The production compilation contract (0.7 candidate) adds no peer range and uses only public Vite/Rollup
hooks (`buildStart`, `buildEnd`, `closeBundle`, and an `order: "post"` `transform`) and the `typescript` peer
for a structural check; it does not touch Angular or Analog private APIs. The barrier mitigates how Analog 2.7.2
shares one Angular plugin between concurrently built environments; another Analog version must be re-qualified
(the packed consumer's adversarial schedule is the control). Node and local workerd are held to the same
contract; JIT-mode production builds are outside it. See
[the report](research/server-component-ssr-integrity-v07.md).

# Analog 0.11.0 route registration candidate

The candidate rejects Strata-owned routes whose normalized final paths share a supported static/named-parameter
shape but differ in template, regardless of method. Nitro 2.13.4 / H3 1.15.11 reuses parameter-name metadata
across methods, so `GET /x/:id` and `POST /x/:slug` are ambiguous too. Identical templates across methods,
static routes beside parameter routes, and unsupported Nitro patterns outside `apiBoundary` remain allowed.
Native Nitro routes are not discoverable by Strata and remain outside this guarantee; consumers can declare
native route metadata to `apiBoundary` where its contract applies. See the
[registration integrity evidence](research/analog-registration-integrity-v011.md).
