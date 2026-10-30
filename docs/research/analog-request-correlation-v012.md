# Analog request correlation (0.12.0 candidate)

Evidence for `requestCorrelation` in `@strata-sc/analog`: an opt-in, request-local identifier that ties one Strata
controller invocation's guards, interceptors, controller factory, handler and final `onRequestSettled` observation
together. Implemented, unit tested, locally integrated and packed-consumer qualified. Not hosted-CI qualified when
this was written (see "Hosted CI"), not deployed, not production adopted, and not M3 or Strata 1.0 certification.

- **Starting `main`:** `0fc8487e3d926600371e9b0f76e9630b1405815a` (merge of PR #153), branch
  `feat/analog-request-correlation-v012`. `@strata-sc/analog` was 0.11.0, `@strata-sc/core` 0.2.2,
  `@strata-sc/server-components` 0.13.0. One minor Changeset targets `@strata-sc/analog` (expected 0.12.0); no
  version is edited by hand and nothing is published, tagged or deployed from the branch. PR #153's real-browser
  Server Component reference-refusal qualification is untouched. Issue #117 (exact-SHA CI release gate) is not
  modified here.
- **Framework tuple (unchanged, lockfile not modified):** Analog platform 2.7.2, `@analogjs/router` 2.7.2 /
  `@analogjs/vite-plugin-nitro` 2.9.2 (as installed by the packed consumer), Nitro 2.13.4, h3 1.15.11, Vite 8.3.0,
  TypeScript 6.0.3 and 5.9.2, Wrangler 4.135.0, workerd compatibility date 2026-09-21.

## Public API

```ts
registerControllers(router, controllers, {
  requestCorrelation: true, // default false; must be a boolean
  onRequestSettled(observation) {
    observation.correlationId; // optional readonly string
  },
});
// request.correlationId: optional readonly string, on every StrataAnalogRequest
```

`requestCorrelation` rejects non-boolean values with `StrataAnalogConfigurationError`. The value is
`globalThis.crypto.randomUUID()`: no Node-only import, available on the pinned Node and workerd. It is generated at
the very start of the route handler, before the request object and the first guard, and stored on the frozen
request and in the invocation's observation tracker. It is never read from headers, query, cookies or bodies, and
contains no user, tenant, route parameter, credential or timestamp.

## Lifecycle contract

One value per matched Strata invocation, carried by the explicit request object (no `AsyncLocalStorage`, no global
registry, no ambient context), so it survives `await`. The same value is seen by the guards, interceptors,
controller factory, handler and the terminal observation. Outcome classification, status handling, LIFO cleanup,
`AggregateError` precedence and exactly-once observation are unchanged; the id never changes an error or a body.
For an owned `streamResponse()` the id stays in the observation tracker until the body completes, fails or is
cancelled; returning the stream emits nothing. Client disconnect remains unsupported on the pinned adapters and is
not claimed. Native Nitro routes, Analog server functions and the API boundary's own answers do not participate.

## Disabled / default behavior

No identifier is generated (a unit test spies on `randomUUID`), `request.correlationId` is absent, and the
observation does not contain a `correlationId` key: its exact previous key set is asserted. The only hot-path
addition when disabled is one boolean-driven ternary.

## Correlation is not authorization

The id is for operational correlation only. It is not a session, tenant, CSRF or authorization value, is never
automatically added to a response header or body, and a client-sent `x-request-id` is ignored. Exposing it
(for example as a response header) is explicit consumer policy; the package README shows a safe example.

## Evidence

**Unit (packages/analog/src/request-correlation.test.ts, 24 tests on a real h3 router):** default disabled;
enabled; invalid option; one id per request; the same id in guard, interceptor, factory, handler before and after
`await`, and observer; client values ignored; unique ids; 24 overlapping requests isolated (also while mixing
success, denial and failure); guard denial; input rejection (400, id absent from body); application error (409,
no id in body or headers); unexpected exception; factory failure; cleanup failure; handler plus cleanup failure
(`cleanup-failed`, id kept); stream completion, failure, cancellation and cleanup failure; throwing and
rejecting observers; no observer; synthetic private canary with a positive detection control.

**Real Analog fixture (`pnpm test:analog-correlation`):** Nitro Node production server, Vite dev server
(Analog development mode) and local Wrangler/workerd, all passing. Covers GET, validated POST (200 and 400), guard
denial (403), interceptor, controller factory, cleanup, an unexpected error (5xx), a stream, 24 overlapping
requests with distinct synthetic identities (one id per request across all six stages, all ids unique, each with
exactly one matching observation), no response header or body id, canary absence in the recorded log, the native
Nitro route unaffected and the real `serverFn` results unchanged (Node/dev 200/200/400/404/405; workerd keeps its
documented pinned NO-GO: Angular JIT is unavailable, `serverFn` answers 500, not addressed in this minor).

**Packed consumer (`pnpm test:full-stack-package-consumer`):** the built tarballs are installed outside the
workspace; the same correlation probe runs against the installed package on a real Nitro production server and on
the consumer's `wrangler pages dev`; `src/check/correlation-example.ts` compiles under TypeScript 6.0.3 and 5.9.2
with `strict` and `skipLibCheck: false`, and asserts (via `@ts-expect-error`) that the id is readonly and the option
is boolean. 0 diagnostics in both; no source aliases into the repository.

## Performance

`pnpm test:analog-correlation-performance`, in-process h3 workload (guard + interceptor + factory + handler),
interleaved rounds, median of 9 rounds of 4000 requests, one Apple-silicon macOS machine (relative only):

| Mode     | Median per request | Throughput   |
| -------- | ------------------ | ------------ |
| disabled | 39.14 us           | ~25.5k req/s |
| enabled  | 39.93 us           | ~25.0k req/s |

Delta about +0.8 us per request (about 2 %), within the run-to-run noise one should expect; no throughput claim is
made. Retained heap after 20000 requests and a forced GC was a few tens of KB in both modes (no growth with
correlation enabled). The code keeps no map, cache or history: the id lives on the request and the per-invocation
tracker, both collectable when the invocation (and, for a stream, its body) settles.

Library bundle (`esbuild --minify`, `h3` and core external) of `dist/index.js`: 25,615 B to 25,924 B (+309 B,
+104 B gzip, 8,862 to 8,966 B). The library delta is what a Node server bundle or a Worker bundle gains; a separate
fixture-level server/worker delta was not isolated because the fixture also gained the test controller.

## Hosted CI

Recorded in the pull request after the branch was pushed; see the final report.

## Remaining limitations

M3 is not complete. Not delivered: distributed tracing or propagation, an observability SDK, client-disconnect
cancellation, shared SSR/controller Angular DI, `serverFn` on workerd, production authentication, tenant
isolation, deployed (Cloudflare) qualification or production adoption of this feature, and Strata 1.0.
