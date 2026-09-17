# Compatibility policy

Policy date: 2026-09-17. There is **no production support matrix yet**. Distinguish manifest ranges,
locally exercised versions, researched candidates and qualified release combinations.

## Baseline and target selection

| Layer           | Evidence today                                                                               | Initial qualification policy                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node            | Manifests `>=22`; CI configured for 22; local tests on 22.23.0                               | Initially qualify Node 22 at a concrete patch satisfying all consumer engines. Reassess maintained Node lines before RC; `>=22` is not a promise of every future major. |
| H3              | Adapter range `^2.0.1-rc.1`, lock/consumer 2.0.1-rc.32; runtime passes, strict types blocked | Initial standalone adapter baseline is the locked v2 RC. Pin exact test resolutions; no v1 claim. Resolve Analog mismatch at M2.                                        |
| Angular         | Not installed                                                                                | First investigate a published Angular 22 tuple compatible with TS 6.0.3; verify exact compiler/SSR/core versions together. No support claim yet.                        |
| Analog          | Not installed; current source documents 2.x integrations                                     | Pin a coherent released platform/router/Angular-plugin/Nitro-plugin set in M2. Verify required server-function APIs exist; mutable `main` is not a release.             |
| Nitro           | Not installed; Analog source currently declares nitropack 2.x                                | Test the version Analog actually resolves. Do not substitute Nitro 3 documentation or config without a migration experiment.                                            |
| TypeScript      | 6.0.3 in repository and isolated consumer; explicit libs omit `esnext.error`                 | M1 baseline 6.0.3; consumer compiler must satisfy Angular's exact peer constraints. No assumption that an Angular 21 app accepts it.                                    |
| Vite / Rolldown | Vite 8.3.0; workspace Rolldown 1.2.8, retained consumer 1.2.9                                | Qualify dev and production builds on the pinned tuple; broad upstream peers do not validate transform order.                                                            |
| Cloudflare      | No fixture or deployment                                                                     | Pin workerd/Wrangler, compatibility date, flags and Nitro preset. Qualify actual Workers execution, including Analog deployment output.                                 |
| Browser         | No browser tests                                                                             | Adopt the selected Angular version's browser policy and record tested browser versions in M4/M5.                                                                        |

Upstream constraints and source links are in [RESEARCH](RESEARCH.md). A supported tuple must include
all these layers together, the Strata candidate digest and the fixture lockfile. Individual compatible
ranges do not establish that their cross-product is supported.

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
