# Compatibility policy

The full-stack authorization fixture's protected paths passed with the packed and exact published-registry tuples on Node, local workerd and Chromium. This adds no package support-matrix claim. See [the authorization report](research/full-stack-authorization-isolation.md).

Policy date: 2026-09-17. There is **no production support matrix yet**. Distinguish manifest ranges,
locally exercised versions, researched candidates and qualified release combinations.

## Versioning, deprecation and migration policy (pre-1.0)

Written 2026-11-05 for 1.0 criterion #26 ([hardening report](research/pre1-runtime-hardening.md)). It
governs the published packages `@strata-sc/core`, `@strata-sc/analog` and `@strata-sc/server-components`
until 1.0; `@strata-sc/h3` stays private. It is a release rule, not a support promise: every API is
still experimental.

**Version numbers (SemVer 0.x, owned by Changesets).**

- A **patch** (`0.y.Z`) never changes the public API inventory
  (`tools/package-consumer/public-api.json`), a documented behavior, a wire format or a peer range. It
  fixes a defect, with a regression that fails on the previous version (example: analog 0.12.1, keep-alive
  after 413).
- A **minor** (`0.Y.0`) may add API and, before 1.0, may also change or remove experimental API. Every
  such change names itself as breaking in its Changeset and in the CHANGELOG entry, with the migration
  steps below.
- No change is published without a Changeset; tooling-, test- and documentation-only work uses an empty
  Changeset and publishes nothing.
- Prereleases use Changesets pre mode and the `next` dist-tag; stable versions move `latest`, and `next`
  is never left behind `latest` ([ADR-005](adr/005-npm-dist-tag-channels.md)). Publishing happens only
  from the Release workflow after a successful `Verify` of the exact main SHA (issue #117).

**Deprecation.** A public export that will be removed or changed incompatibly is first marked
`@deprecated` in its declaration with the replacement, and listed in the CHANGELOG, in a release that
still contains it. Before 1.0 a removal may follow in the next minor; after 1.0 removal waits for the
next major. Security fixes may skip the deprecation step and say so.

**Migration requirements for a breaking minor.** The CHANGELOG entry carries the steps; the reviewed
public API inventory is updated in the same PR; the packed consumers pass with the new version; and when
the change touches the client boundary protocol, build identity or anything a deployed browser holds,
the published A/B upgrade/rollback qualification
(`pnpm test:full-stack-registry-upgrade-rollback`) runs for the old and new versions before the release
is called qualified.

**Declared ranges versus the qualified tuple.** Peer and engine ranges say what a package accepts; only
the frozen candidate below says what was qualified. A tuple outside the candidate is not supported even
if it installs. Strata does not promise arbitrary Angular, Analog, Nitro or TypeScript versions inside
a declared range: any Angular upgrade re-runs the graph and package-consumer qualifications (RISKS R21).

**Supported runtime shapes (all experimental).** Nitro `node-server` on Node 22 and the Nitro
`cloudflare-pages` preset (compatibility date 2026-09-21, no flags) for controllers, SSR and Server
Components with buffered responses. Not supported: consumer-owned Angular DI and Analog `serverFn` on
workerd (Angular JIT), streaming SSR, client-disconnect cancellation through the Nitro adapters,
incremental streamed delivery on Cloudflare Pages, Router activation into a Server Component subtree.
Native H3 routes remain the escape hatch and coexist with Strata routes on Nitro/H3 v1; the H3 v2
adapter is private (strict consumer types upstream-blocked).

**Server Component protocol guarantees.** Protocols v1 (flat primitives) and v2 (bounded structured
JSON) are experimental. Within one deployment, a payload the server writes is one the browser of the
same build accepts. Across deployments the only guarantee is fail-closed: with build identity, a
document and script of different builds are refused as a build mismatch (and, when opted in, recovered
by one bounded reload), never hydrated across versions. No wire compatibility between two minors is
promised before 1.0.

**Unexpected SSR render failures.** Native Analog answers them with HTTP 200 and an incomplete
document; an application that does not opt in keeps exactly that. From server-components 0.15.0 the
opt-in `@strata-sc/server-components/ssr` entry provides the contract over public Angular/Analog APIs
only: `provideStrataSsrFailureHandler(RESPONSE)` (an application-level `ErrorHandler` that marks the
per-request Analog `RESPONSE`) and `withStrataSsrFailureContract(render(...))`, which turns a marked or
rejected buffered render into a generic HTTP 500 (`no-store`) before the response is written
([report](research/ssr-failure-contract.md)). Strata does not install it implicitly. Published tuples
that predate the entry (server-components ≤ 0.14.x, including the frozen candidate below) are
qualified with the equivalent consumer-owned recipe
(`tests/full-stack-package-consumer/recipes/ssr-failure-contract.ts`). Streaming SSR and
already-committed responses are not covered.

## RC0 support contract

Proposed 2026-11-06 for maintainer review ([report](research/rc0-production-qualification.md),
[SPEC-004](specs/004-first-release-candidate.md)). No RC exists yet. This narrows what an RC may promise. Ids
are stable; cite them instead of a table position.

**Strata tuple.** `@strata-sc/core`, `@strata-sc/analog` and `@strata-sc/server-components`, all at the same
`1.0.0-rc.N`. A mix with any other version, including a `0.x` line, is outside the contract.

**Framework tuple.** Node 22; Angular 22.2.3; Analog 2.7.2; Vite 8.3.0; Nitro 2.13.4; H3 1.15.11; TypeScript 6.0.3 or
5.9.2; Wrangler 4.135.0; compatibility date 2026-09-21, no flags. One exact tuple, not a range. No peer range
widens for it.

### Supported for RC evaluation

| Id                   | Capability                                                                 | Evidence                                                        |
| -------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `SC-NODE`            | Node 22 with Nitro `node-server`                                           | PRODUCTION PROCESS on hosted Linux; no persistent deployment    |
| `SC-PAGES`           | Cloudflare Pages preset, pinned compatibility settings                     | DEPLOYED, source-packed and published                           |
| `SC-API`             | Standard decorators and the reviewed public API                            | installed declarations = runtime exports = inventory            |
| `SC-SSR`             | Buffered Server Component SSR                                              | packed, published, deployed                                     |
| `SC-SSR-FAILURE`     | Opt-in `/ssr` failure handling, the safe SSR configuration of this profile | packed, deployed; integration refusal on Node and local workerd |
| `SC-NAVIGATION`      | Explicit document navigation                                               | Chromium, packed and deployed                                   |
| `SC-ISLANDS`         | Client islands: one and three per page, installed Angular library islands  | packed, Chromium, hydrated and replayed interaction             |
| `SC-AUTHORIZATION`   | Application-owned authorization, request isolation                         | packed, multi-isolate, adversarial, deployed                    |
| `SC-CONFIDENTIALITY` | Graph confidentiality of **explicitly marked** code                        | tarballs, Node and workerd builds                               |
| `SC-PROTOCOL`        | Serialization and boundary protocol v1/v2                                  | unchanged; `1`/`2` accepted as documented                       |
| `SC-BUILD-IDENTITY`  | Build identity, and one bounded reload on deployment skew                  | deployed A/B on published tuples                                |
| `SC-ROLLBACK`        | Release, retained-artifact rollback                                        | deployed A/B on published tuples                                |

`SC-SSR-FAILURE` is required for the supported SSR profile: both halves, `withStrataSsrFailureContract` around the
real Angular render and `provideStrataSsrFailureHandler` in the server application configuration. Without
them a failed render can still answer HTTP 200.

**Dependencies the contract carries.** The build plugin reads `@angular/compiler` template-AST exports ([R21](RISKS.md))
and islands hydrate from the `ngh` annotation Angular writes. Both are why this is one exact tuple: another Angular
version is outside the contract until it is qualified.

**Separate injectors.** Controller Angular DI and SSR rendering do not share an injector, and a request's
controller scope is not visible to a Server Component. They are two runtimes that happen to use the same library.

### Experimental

| Id                 | Capability                         | Limitation                                                                       |
| ------------------ | ---------------------------------- | -------------------------------------------------------------------------------- |
| `EX-DEFER`         | `@defer` and hydration composition | the combinations in `pnpm test:server-component-defer` only; no real application |
| `EX-SERVERFN`      | Controller `serverFn` coexistence  | Node only                                                                        |
| `EX-STREAM`        | `streamResponse()`                 | finite bodies; no failure signal after a body fails; buffered on Pages           |
| `EX-OBSERVATION`   | Observation and correlation hooks  | not tracing or telemetry                                                         |
| `EX-CONTROLLER-DI` | Angular DI in controllers          | Node; not shared with SSR                                                        |

### Unsupported

| Id                 | Capability                                                                                     | Reason                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `NO-JIT-WORKERD`   | Angular JIT-dependent integrations on workerd, including Angular DI controllers and `serverFn` | upstream; fails safely                                          |
| `NO-STREAMING-SSR` | Streaming SSR                                                                                  | the `/ssr` contract covers buffered rendering only              |
| `NO-SPA`           | Server Components through SPA or Router subtree navigation                                     | document navigation only                                        |
| `NO-DISCONNECT`    | Client-disconnect cancellation                                                                 | no transport signal through the pinned adapters                 |
| `NO-H3-V2`         | `@strata-sc/h3` and its H3 v2 adapter                                                          | private; upstream strict-type blockers (SPEC-002)               |
| `NO-UNMARKED`      | Confidentiality of unmarked modules                                                            | ownership only; mark them `server-only`                         |
| `NO-DUPLICATES`    | Duplicated Strata or Angular installs                                                          | `/ssr` refuses incompatible ones; other entries are unqualified |
| `NO-OTHER`         | Other package compositions or framework versions                                               | not qualified                                                   |

### Migration: `/ssr` in server-components 0.17.0

0.17.0 changes the public types of the opt-in entry, and it changes behaviour.

| Change                                                                            | What to do                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `provideStrataSsrFailureHandler` returns `EnvironmentProviders`, not `Provider[]` | Register it in the server `ApplicationConfig`. It no longer spreads, and a component cannot host it |
| `StrataSsrFailurePhase` gains `"integration"`                                     | An exhaustive `switch` or a `Record` over the phases must handle it                                 |
| A wrapper without a connected provider fails every request with HTTP 500          | Register both halves. A provider without a compatible wrapper rejects the bootstrap                 |
| The inner render must be a real Angular render                                    | Do not wrap a cache of finished documents                                                           |

The recommended form is compiled in the installed consumer on TypeScript 6 and 5.9
(`tests/full-stack-package-consumer/fixture/src/check/ssr-migration.ts`). Duplicated copies are refused or
work only where [the matrix](research/rc0-production-qualification.md#ssr-installation-integrity) says so:
two copies both at 0.16 or older cannot be detected, and an old wrapper beside a new provider that loads a
second Angular still answers HTTP 200.

## Frozen release candidate (2026-11-06)

Current: `893a15145303f585` (core 0.2.2 / analog 0.12.1 / **server-components 0.16.0**), the first line with the real
`/ssr` export and the PR #175 graph hardening as published. Source-packed work is a separate candidate
([report](research/rc0-production-qualification.md)).

## Previous frozen candidate (2026-11-05, recaptured)

Then current: `402f33e953f9a04b` (core 0.2.2 / **analog 0.12.1** / server-components 0.14.0), recaptured from
a passing fresh registry run and reproduced with `npm ci`; consumer lock 869 packages, TS 5.9 lock 80,
same toolchain as below ([report](research/pre1-runtime-hardening.md)). The previous candidate,
kept as history below, used analog 0.12.0.

### Previous candidate

The exact qualified combination is now a committed, reproducible artifact, `tests/full-stack-candidate`
(id `318670103337b243`, [report](research/m5-production-qualification.md)): Strata core 0.2.2 / analog 0.12.0 / server-components 0.14.0 with
their npm integrities, the complete consumer lock (869 packages) and the TypeScript 5.9 declaration lock, the
resolved framework tuple (as below, plus `@analogjs/vite-plugin-nitro` 2.9.6, Rolldown 1.2.0, workerd
1.20260918.1) and the toolchain (Node 22, Playwright 1.62.1, Wrangler 4.135.0, compatibility date 2026-09-21,
no flags). It is one exact tuple, not a support range. Manifest peer and engine ranges are **not** narrowed:
the lower Angular bound (22.1.7) is exercised by the performance fixture and 22.2.3 by the full-stack
fixture, so the evidence does not contradict `^22.1.7`, but it does not qualify the whole range either.

## Current tested tuple and evidence levels (2026-11-05)

This section is the current reconciliation; the sections below keep their historical record. It is
evidence for one exact tuple on synthetic fixtures, **not** a support range
([stabilization report](research/m3-m4-contract-stabilization.md)).

**Published versions (npm, 2026-11-05):** `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.12.0,
`@strata-sc/server-components` 0.14.0 (`latest` and `next` agree). `@strata-sc/h3` is private and
unpublished. The pending Changeset makes `@strata-sc/analog` 0.12.1 (patch: an oversized validated
body no longer desynchronises a Node keep-alive connection); no public API changes.

**Manifest ranges (what the packages declare, not what is qualified):** every package `engines.node`
`>=22`. `@strata-sc/server-components` peers: `@angular/core`, `@angular/compiler`,
`@angular/common` (optional), `@angular/router` (optional) `^22.1.7`; `typescript` `^5.9.0 || ^6.0.0`;
`vite` `>=8.3.0 <9`. `@strata-sc/analog` declares no peer; it depends on `@strata-sc/core` (exact
version) and `@standard-schema/spec` 1.1.0. Nitro, H3 and Analog are not declared: they come from
the host application.

**Exact tested tuple (direct dependencies, pinned by the external fixtures):** Node 22.23.1 locally
(Node 22 on hosted runners); Angular 22.2.3 (core, compiler, common, platform-browser,
platform-server, router, compiler-cli) with `@angular/build` 22.1.8; Analog platform, router and
Angular Vite plugin 2.7.2; nitropack 2.13.4; h3 1.15.11; Vite 8.3.0; TypeScript 6.0.3 (declarations
also 5.9.2); Wrangler 4.135.0 with compatibility date 2026-09-21 and no `nodejs_compat`; Playwright
1.62.1 Chromium. Each external consumer is a fresh `npm install` without a lockfile, as a real
consumer would do, so **transitive** versions follow the registry on the day of the run and are
recorded per run, not pinned: on 2026-11-05 `@analogjs/vite-plugin-nitro` resolved 2.9.6 (2.9.5 on
2026-11-02) and Rolldown 1.2.0.

| Evidence level     | What it means here                                                                                                  | Current state                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest range     | What `package.json` accepts                                                                                         | Above. Broader than anything tested; not a claim.                                                                                                             |
| Exact tested tuple | The versions the fixtures pin, plus the recorded transitive set                                                     | Above, Node + local workerd.                                                                                                                                  |
| Packed consumer    | Branch tarballs installed outside the workspace, strict TS 6.0.3/5.9.2, Node production (+ workerd where supported) | Mandatory CI. Public API inventory (installed declarations = runtime = reviewed baseline) added 2026-11-05.                                                   |
| Published registry | The same consumers installing exact npm versions                                                                    | 2026-11-02 tuple (sc 0.13.0) qualified; Extended `registry` suite now runs the full-stack registry consumer weekly.                                           |
| Local workerd      | `wrangler pages dev` of the Cloudflare Pages preset                                                                 | Supported: controllers, SSR, Server Components, streaming lifecycle. **NO-GO**: consumer Angular DI and `serverFn` (Angular JIT `EvalError`), fails safely.   |
| Hosted CI          | GitHub-hosted `ubuntu-latest`, the `Verify` aggregate                                                               | Every PR. Extended (weekly/manual) could not start from PR #167 until this work repaired its workflow file.                                                   |
| Real deployment    | Isolated Cloudflare Pages projects, manual workflows                                                                | Server Components alone: narrow GO (2026-10-12). Full-stack fixture: one published-tuple GO (2026-11-02), earlier NO-GO runs kept. No Node server deployment. |
| Production support | A maintained, documented promise                                                                                    | **None.** No Strata package is production-supported; every API remains experimental before 1.0.                                                               |

**Experimental or unsupported, precisely:** the H3 v2 adapter (`@strata-sc/h3`, private, strict
consumer types upstream-blocked); consumer-owned Angular DI and Analog `serverFn` on workerd (NO-GO);
client-disconnect cancellation through the pinned Nitro adapters (no signal reaches Strata);
incremental streamed delivery on Cloudflare Pages (buffered); streaming SSR; Angular Router
activation into a Server Component subtree (document navigation only); arbitrary npm Angular packages
as islands (one package shape qualified); a module that does not itself assert `server-only` is not
protected by the firewall. The Vite plugin reads Angular template ASTs through `@angular/compiler`
exports (`parseTemplate`, `TmplAst*`, `CssSelector`), which Angular does not version as application
API: any Angular upgrade must re-run the graph and package-consumer qualifications (RISKS R21).

## Baseline and target selection

_Historical (2026-09-17, M1 target selection). Superseded for the current tuple by the section above;
kept as recorded._

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

The installed-island qualification slice (feature branch) exercises one private, partial-compiled Angular
library (two versions) installed from npm tarballs on the existing tuple (Angular 22.2.3, Vite 8.3.0, TypeScript
6.0.3, Nitro Node and local workerd). It qualifies only that package shape (standalone components with public
inputs from an APF FESM entry with partial declarations, registered explicitly) and adds no peer range. An
arbitrary npm Angular component is not claimed as supported. See the [installed-island report](research/server-component-installed-island-qualification.md).

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

The optional `@strata-sc/server-components/ssr` entry adds no new peer range: it imports only
`@angular/core` (`ErrorHandler`, `inject`) and receives the host's response token from the
application, so it has no Analog, Nitro or H3 dependency. It is qualified with Analog 2.7.2's buffered
`render()` on Nitro `node-server` and local workerd (Cloudflare Pages preset); `renderStream` is
unsupported. See the [SSR failure contract report](research/ssr-failure-contract.md).

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

## Request correlation assumptions

`requestCorrelation` uses `globalThis.crypto.randomUUID()`, present on the pinned Node and workerd runtimes, and
adds no dependency or Nitro/H3 type. It is request-local (no `AsyncLocalStorage`). Qualified on the tuple of the
[report](research/analog-request-correlation-v012.md) (Nitro Node, Vite dev, local workerd, packed consumer with
TypeScript 6.0.3 and 5.9.2); not a deployed Pages project. `serverFn` on workerd stays NO-GO (Angular JIT).

`validateHeaders` (0.9 candidate) reads the same normalized `Headers` on Nitro Node, Vite dev and local workerd: lowercase
names, duplicates combined with `", "`. Qualified locally on that tuple, not on a deployed Pages project
([report](research/analog-header-validation-v09.md)).

## Installed-package server-only contract (Server Components, next minor)

What a browser graph refuses, by how the module is classified
([report](research/installed-package-graph-hardening.md)):

| Case                                                                       | Contract                                                                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Explicitly marked module (plain side-effect import of the assertion)       | Refused in every browser graph: import, `import()`, `@defer`, query, worker, `new URL()`                                            |
| Package entry re-exporting one (`export *`, named, namespace, chained)     | Refused at the entry, whichever export is selected, through Vite's client resolution; across packages and `#imports` too            |
| Unrelated safe subpath, or the `browser` condition of a conditional export | Allowed: an entry is judged, never a package                                                                                        |
| Type-only re-export, `export { type T } from`                              | Allowed: it loads nothing                                                                                                           |
| Unmarked package code                                                      | **Not classified.** Reachable and shippable, including under `?raw`; the firewall reads assertions, not source semantics            |
| Marker written as `require()` or `import {} from`                          | Refused when loaded as a module; **not recognized under a query**                                                                   |
| Package export the consumer never imports                                  | Not exercised and not analyzed: the walk starts only from what a browser graph reaches                                              |
| Editing `node_modules` in place                                            | Unsupported. The directly imported entry is re-read; a module behind an ordinary import stays stale until `--force` or a cold cache |

Behavior change: a build that shipped a marked module through a query, `new URL()` or a worker now
fails. There is no new option or export. `createIdResolver` (public in Vite) and `worker.plugins` are
the seams used; the peer range stays `vite >=8.3.0 <9`.

## Deployment skew (Server Components 0.8)

The build identity depends only on Vite `define` reaching every environment of one `vite build` and on the
runtime being bundled into the SSR graph (`ssr.noExternal`, already required). Qualified on the packed
consumer tuple Angular 22.2.3, Analog 2.7.2, Nitro 2.13.4, Vite 8.3.0, TypeScript 6.0.3, Wrangler 4.135.0
(Nitro Node and local workerd). Split builds must pass the same value to every part. A deployed Cloudflare
Pages run and CDN cache semantics are not qualified. See the
[report](research/server-component-deployment-skew-v08.md).

## Published-registry tuple (2026-11-02)

Qualified from npm at exact versions on the synthetic full-stack fixture: `@strata-sc/core` 0.2.2,
`@strata-sc/analog` 0.12.0, `@strata-sc/server-components` 0.13.0 with Angular 22.2.3, Analog platform 2.7.2,
Nitro plugin 2.9.5 (nitropack 2.13.4), Vite 8.3.0, TypeScript 6.0.3 and 5.9.2 (declarations), Wrangler 4.135.0,
Node 22: Nitro Node, local workerd and one isolated Cloudflare Pages deployment. This is an
exact tuple, not a range or support matrix. Other versions are qualified by setting
`STRATA_REGISTRY_*_VERSION`; an unpublished version is reported NOT AVAILABLE. See the
[report](research/full-stack-registry-qualification.md).

Version transition (2026-11-02): moving between the published `@strata-sc/server-components` 0.12.0 and 0.13.0
(with `core` 0.2.2 and `analog` 0.12.0, same Angular/Analog/Nitro/Vite/TypeScript/Wrangler tuple) and back is
qualified locally on Node and workerd, including documents and scripts of different releases meeting in the
browser. It is one pair that differs by three files, not a compatibility range, and no real deployment was
exercised ([report](research/full-stack-registry-upgrade-rollback.md)).

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
