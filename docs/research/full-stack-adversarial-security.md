# Full-stack adversarial security qualification

**Status:** packed and published-registry qualifications passed locally on 2026-11-04. Hosted PR checks are pending. This report does not qualify production tenant isolation, authentication, sessions, caching, CSRF, M4, M5, or Strata 1.0.

## Provenance

- Starting main SHA: `475e36902afb5a751ab7d7124f37682d50c4f07a` (2026-11-04; PR #166).
- Branch: `test/full-stack-adversarial-security`.
- PR: pending creation.
- Packed tuple: `@strata-sc/core@0.2.2`, `@strata-sc/analog@0.12.0`, `@strata-sc/server-components@0.14.0`.
- Published registry tuple: all exact versions and registry tarball integrity records verified from `registry.npmjs.org`; the runner never substitutes packed artifacts in registry mode.
- Registry integrity: core `sha512-Xr6bMt7funa/RtMhr/BTLX548alI8w5/tq/4QIgvk4INEc4nED5CweQUeEujPU6o9/NcJ1XFtqcXPNGjohkHFA==`; analog `sha512-jHkt/GbJ3nMvzwuVzRnDYQ6dfTPpcEN7jm+qGADvP0whTKs56qT/QkR9lmJ9vnSfrxyNgmt8jIl2n963BjWAuA==`; server-components `sha512-GoaNuTU/cOJgVme9hyXziAjD7bmszRmxZUah8yaDUcrMv7T5Kw/qgH4IJSqILs6Q8Ng78VssKq5MXugQWkj7bw==`.
- Packed tarball SHA-256: core `49434df58bb205fb1a69c07eb1b9b6cb334b2e1b7161343f1cbbc0167995bfcb`; analog `76c48ae27b024f29ff96fce5f17e3d5e5c82aa1f11f1671f06025b514394afaa`; server-components `16869a3b7a92d15853c7a9986a6134faf97683290c7f8e554195068283af2fae`.

## Method

`pnpm test:full-stack-adversarial-security` prepares one healthy full-stack external npm install from real packed Strata tarballs, verifies its lock/integrity and TypeScript 5.9 install, then copies the external fixture into a new source directory for each scenario. The variants reuse that same verified package installation and lock identity, apply one exact one-occurrence source mutation, record the changed file SHA-256, and independently run the complete production Node and Cloudflare Pages builds, actual HTTP paths, Chromium interactions, and graph/confidentiality scans. Package artifacts and dependencies are not needlessly reinstalled for each app source variant. The original fixture is snapshotted and compared after all runs. A failed install, typecheck, build, or startup is not accepted as a security rejection.

The PR workflow runs the ownership-removal scenario as a mandatory smoke. The Extended workflow runs all scenarios; failure diagnostics include retained consumer builds.

The authorization-before-read probe is fixture-owned and request-local. API requests carry a random observation key; the protected resource function records its call count under that key, and a test-only endpoint consumes the count. SSR renders the read count returned with the resource result. Healthy API and SSR matrices expect one read for authorized resources and zero for denied, unauthenticated, malformed, and unknown-resource requests. A 24-request API overlap also verifies counts stay attached to the request that caused them. Mutation A must turn the cross-tenant denial into a successful API/SSR read.

The packed consumer's declaration stage typechecks the actual tenant authorization helper, protected controller, and SSR component under strict settings with the appropriate standard or Angular decorator mode. TypeScript 6.0.3 and 5.9.2 each reported zero diagnostics. Angular's production compiler still performs template checks. Other fixture application sources are not all included in these two targeted TypeScript projects; that boundary remains explicit.

## Source mutations and expected rejection

| Scenario                   | Exact source fault                                                                         | Expected production verifier rejection                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A: ownership removal       | `authorize` returns 200 for every authenticated principal, retaining credential resolution | Node and Workerd API/SSR matrices rejected cross-tenant 200 responses; the API observation counter showed a read on the vulnerable request. |
| B: data substitution       | Protected resource lookup returns beta as the tenant for every requested resource          | Node and Workerd API/SSR/browser checks rejected beta data attached to alpha identity. Private markers remained forbidden.                  |
| C: browser confidentiality | The Angular island's initial browser-visible state contains `ALPHA_CONFIDENTIAL_71c1`      | The marker must be found in generated browser assets, then the existing all-assets/source-map scanner rejects the contaminated artifact.    |

Expected SHA-256 digests from the deterministic single-replacement operation (the runner rechecks each value before the consumer copies and builds the fixture):

| Scenario | Original source                                                    | Mutated source                                                     |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| A        | `9fe5ca4df7938aaebc7081d20f1cebbd75c9b99374182ec6c6cebcd7f7172d4b` | `5a5e77b676fe0c0baed3580fd4ee005a1df7e1597206bdbb1c47aeb6342f9047` |
| B        | `9fe5ca4df7938aaebc7081d20f1cebbd75c9b99374182ec6c6cebcd7f7172d4b` | `8ebb646e8a6b1f7f58f9b1cbf282fc43eb2f9fc22b1e8ac9908ce1d27a6af1db` |
| C        | `a44f8b9863052e3558a6621f90f9d5ad90810f21a1eec527f03221ab067cc097` | `a728f5e73c812921659d891d954b2b3fc65cacca02e717a907bd24cfa93c8180` |

Mutation C was rejected because the marker appeared in browser JavaScript and its source map (`client/assets/product-details.server-component-CgEep-Ax.js` and the matching `.map`; also copied under `analog/public/assets/`). Marker presence was the positive control. All three mutations reached Node, local Workerd and Chromium paths; the full runner passed and the original fixture remained byte-identical.

Final mutated-source digests: A `5a5e77b676fe0c0baed3580fd4ee005a1df7e1597206bdbb1c47aeb6342f9047`; B `8ebb646e8a6b1f7f58f9b1cbf282fc43eb2f9fc22b1e8ac9908ce1d27a6af1db`; C `a728f5e73c812921659d891d954b2b3fc65cacca02e717a907bd24cfa93c8180`.

## Evidence levels

| Evidence level     | Result                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| IMPLEMENTED        | Isolated source-mutation runner, strict target matching, fixture-owned read evidence, and positive/negative assertions |
| UNIT               | PASS — `pnpm test:release` (110 tests)                                                                                 |
| LOCAL NODE         | PASS — packed consumer, all three mutations, registry consumer, focused runtime suites                                 |
| LOCAL WORKERD      | PASS — packed consumer, all three mutations, registry consumer, focused runtime suites                                 |
| PACKED CONSUMER    | PASS — healthy external npm install and all three mutated source builds                                                |
| PUBLISHED REGISTRY | PASS — exact published tuple, registry integrity and full consumer; registry mutation is not run                       |
| HOSTED CI          | Pending PR creation and checks; Extended weekly/manual suite not run locally                                           |
| DEPLOYED           | NOT RUN                                                                                                                |
| REAL ADOPTION      | NOT RUN                                                                                                                |

## Scope and release

The changes are limited to the external fixture, security verification, runner, tests, CI and evidence docs. No public framework API or runtime package behavior changed. The empty Changeset records no package version bump. No package is published and no vulnerable variant is deployed.

The results qualify this synthetic consumer's ability to detect these specific regressions only. They do not qualify production authentication, tenant isolation, caching, CSRF, or a real deployment, and do not close M4/M5 or establish Strata 1.0 readiness.

Other local verification passed: `pnpm build`, `pnpm typecheck`, `pnpm format:check`, `pnpm lint` (0 errors; 5 existing import-order warnings), and `pnpm test` (all package tests, 110 release tests, 172 performance-tool tests). The packed and registry full-stack consumer qualifications passed with exact per-request API read counters, SSR read evidence, and 24 overlapping protected requests. Focused authorization, data confidentiality, request-context and SSR response suites each passed on Node and Workerd.
