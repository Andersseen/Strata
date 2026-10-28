# Server Component client reference integrity (0.12.0 candidate)

## Scope and starting point

Starting synchronized `origin/main` SHA: `02b06a17dbd5e9221bf02367beadabfbf84e54ee`.
Feature branch: `feat/server-components-client-reference-integrity-v012`.
Package version at start: `@strata-sc/server-components` 0.10.0, with the 0.11.0 minor Changeset from
PR #147 pending and preserved. Tuple: the repository-locked one (Angular 22.2.3, Vite 8.3.0,
TypeScript 6.0.3, Node as locked); local evidence only, not a support declaration.

## Build-time guarantees that already existed

The Vite analyzer already rejects: two local imports declaring one element selector; a local
component colliding with a registered package selector; duplicate selectors in the `clientComponents`
registry; two different client components selected for one element under one Server Component; and a
client boundary with no authorized local or package reference. These are unchanged and no second
source-level validator was added.

## Runtime gap and baseline

`provideClientReferences` built a `Map` keyed by `reflectComponentType(type).selector`. Reproduced
with real Angular component metadata (JIT, `@angular/compiler`): for two distinct components with
selector `product-picker`, the map held one entry and the **last type won, silently**; a directive
reflected to `null` and was silently dropped (later reported only as "no client reference has this
selector"). The actual selector of a registered package component was never compared with the one
the build authorized. This is a characterized integrity gap, not a demonstrated exploit.

## Design

- `ResolvedClientReference` (internal) gains the validated `selector` from template analysis.
- Generated surrogates emit `provideClientReferences([{ type, expectedSelector }])`.
- `provideClientReferences` accepts `Type | { type, expectedSelector }` entries (additive; plain
  arrays stay valid, with the checks that need no descriptor). New exported types:
  `ClientReferenceDescriptor`, `ClientReferenceInput`.
- `buildClientReferenceRegistry` (runtime/client-references.ts): one pass over one host's
  references, one reflection per entry, public `reflectComponentType` only, never throws. It
  records the first problem: missing component metadata (non-component, directive), expected versus
  actual selector mismatch, or two distinct types claiming one selector. The same component listed
  twice is accepted. Diagnostics name the position and public selectors only, never class names,
  values or Angular metadata.
- The problem is carried into the existing preflight, so nothing throws in the constructor.

## Ordering and precedence

Within `planClientBoundaries`: (1) boundary count and aggregate payload budgets (`resource-limit`);
then per boundary (2) selector/metadata, (3) build identity (a confirmed mismatch keeps its
build-mismatch classification and recovery policy), (4) registry integrity (`reference`),
(5) selector lookup, (6) protocol and props, (7) inputs. A host with no boundaries is not refused for
a bad registry. No extra DOM scans.

## Error, observer and skew behavior

Category `reference` (no new category). The existing path is reused: one `StrataBoundaryError` to
`ErrorHandler`, one `preflight-refused` observation, no island, no view, no `data-strata-hydrated`,
SSR DOM intact, sibling hosts unaffected. A reference failure never invokes skew recovery.

## Evidence

Implemented and unit tested (package vitest, 377 tests): real-component tests for valid, distinct,
duplicate-selector (regression for the silent overwrite), same component twice, directive, plain
class, mismatch, invalid beside valid, no class name in diagnostics, and plan-level refusal with
`reference` category; surrogate and graph tests for the descriptor output.

Locally integrated (all PASS on this machine): `pnpm build/lint/typecheck/test/format:check`, release
and performance-tools tests, and the Server Components gates (Node production, navigation, defer,
server-only, optimized deps, security, request context, authorization, failures, SSR response,
Analog dev, deployment skew, package consumer, local workerd/Pages), full-stack and Analog packed
consumers, Analog suites, www and Relay checks, and `www:build:cloudflare`. Note: after changing the
runtime, the Analog dev gate failed until Vite's pre-bundled dependency cache
(`apps/*/node_modules/.vite`) was cleared; with a stale cache the old runtime treats descriptors as
non-components. Consumers must rebuild/clear the optimizer cache when upgrading.

## Remaining limitations (NOT done)

- No new browser/fixture negative scenario (wrong package registry selector, two package exports
  with one actual selector) in Node, dev, workerd or packed consumer: only unit/plan-level proof of
  the refusal. Hosted-CI, deployed and packed-consumer negative qualification are pending.
- Island-level tests of ErrorHandler/observer counts for the new refusal reuse the existing
  preflight path but have no dedicated integration test.
- No performance or bundle-size measurement was taken.
- Issue #117 hosted evidence not reviewed here. This does not certify M4 or Strata 1.0.
