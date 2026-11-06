---
title: "Compatibility"
description: "What Strata supports today, and the versioning rules before 1.0."
group: "Start here"
order: 2
---

<!-- Generated from docs/COMPATIBILITY.md by apps/www/scripts/public-docs.ts. Do not edit. -->

## RC0 support contract

Proposed 2026-11-06 for maintainer review ([report](https://github.com/Andersseen/Strata/blob/main/docs/research/rc0-production-qualification.md),
[SPEC-004](https://github.com/Andersseen/Strata/blob/main/docs/specs/004-first-release-candidate.md)). No RC exists yet. This narrows what an RC may promise. Ids
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

**Dependencies the contract carries.** The build plugin reads `@angular/compiler` template-AST exports ([R21](https://github.com/Andersseen/Strata/blob/main/docs/RISKS.md))
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
work only where [the matrix](https://github.com/Andersseen/Strata/blob/main/docs/research/rc0-production-qualification.md#ssr-installation-integrity) says so:
two copies both at 0.16 or older cannot be detected, and an old wrapper beside a new provider that loads a
second Angular still answers HTTP 200.

## Versioning, deprecation and migration policy (pre-1.0)

Written 2026-11-05 for 1.0 criterion #26 ([hardening report](https://github.com/Andersseen/Strata/blob/main/docs/research/pre1-runtime-hardening.md)). It
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
  is never left behind `latest` ([ADR-005](https://github.com/Andersseen/Strata/blob/main/docs/adr/005-npm-dist-tag-channels.md)). Publishing happens only
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
([report](https://github.com/Andersseen/Strata/blob/main/docs/research/ssr-failure-contract.md)). Strata does not install it implicitly. Published tuples
that predate the entry (server-components ≤ 0.14.x, including the frozen candidate below) are
qualified with the equivalent consumer-owned recipe
(`tests/full-stack-package-consumer/recipes/ssr-failure-contract.ts`). Streaming SSR and
already-committed responses are not covered.
