# Compatibility policy

Policy date: 2026-09-17. There is **no production support matrix yet**. Distinguish manifest ranges,
locally exercised versions, researched candidates and qualified release combinations.

## Baseline and target selection

| Layer           | Evidence today                                                  | Initial qualification policy                                                                                                                                            |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node            | Manifests `>=22`; CI configured for 22; local tests on 22.23.0  | Initially qualify Node 22 at a concrete patch satisfying all consumer engines. Reassess maintained Node lines before RC; `>=22` is not a promise of every future major. |
| H3              | Adapter range `^2.0.1-rc.1`, lock 2.0.1-rc.32, in-process tests | Initial standalone adapter baseline is the locked v2 RC. Pin exact test resolutions; no v1 claim. Resolve Analog mismatch at M2.                                        |
| Angular         | Not installed                                                   | First investigate a published Angular 22 tuple compatible with TS 6.0.3; verify exact compiler/SSR/core versions together. No support claim yet.                        |
| Analog          | Not installed; current source documents 2.x integrations        | Pin a coherent released platform/router/Angular-plugin/Nitro-plugin set in M2. Verify required server-function APIs exist; mutable `main` is not a release.             |
| Nitro           | Not installed; Analog source currently declares nitropack 2.x   | Test the version Analog actually resolves. Do not substitute Nitro 3 documentation or config without a migration experiment.                                            |
| TypeScript      | 6.0.3 in repository                                             | M1 baseline 6.0.3; consumer compiler must satisfy Angular's exact peer constraints. No assumption that an Angular 21 app accepts it.                                    |
| Vite / Rolldown | Vite 8.3.0; Rolldown 1.2.8 locked                               | Qualify dev and production builds on the pinned tuple; broad upstream peers do not validate transform order.                                                            |
| Cloudflare      | No fixture or deployment                                        | Pin workerd/Wrangler, compatibility date, flags and Nitro preset. Qualify actual Workers execution, including Analog deployment output.                                 |
| Browser         | No browser tests                                                | Adopt the selected Angular version's browser policy and record tested browser versions in M4/M5.                                                                        |

Upstream constraints and source links are in [RESEARCH](RESEARCH.md). A supported tuple must include
all these layers together, the Strata candidate digest and the fixture lockfile. Individual compatible
ranges do not establish that their cross-product is supported.

## H3 transition

[ADR-002](adr/002-core-and-h3-target.md) preserves the existing v2 experiment. The adapter encapsulates
version-sensitive routing, events, response/error mapping and any bridge; core remains independent.

M2 must compare a dedicated v1 execution path, a tested Web Request/Response bridge and a supported
upstream runtime upgrade. Explicitly test repeated headers/cookies, streaming if supported, status,
base paths, context ownership, abort and error behavior. Never cast an H3 v1 app/event into v2 types.

Support more than one major only if a real consumer needs it and each path has its own CI fixtures,
documented API boundary, maintained dependency floor and accountable maintenance. Otherwise choose
one qualified integration target and document its limits. Reject duplicate runtime packages or
peer conflicts rather than hiding them behind overrides. An override is an experiment, not support.

No new API range may be claimed merely because pnpm resolves it. Review advisories and upstream
release notes before selecting each exact candidate, particularly prereleases; the existing wide RC
range is not a security or compatibility certification. Production eligibility of an upstream
prerelease requires an explicit release decision and full evidence, never automatic promotion.

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
