# Analog request observability (0.8.0 candidate)

Evidence for `onRequestSettled` in `@strata-sc/analog`: an opt-in, request-local observation of how each Strata
controller invocation ended. Experimental fixture evidence: implemented, unit tested, locally integrated and
packed-consumer qualified; not hosted-CI qualified when this was written, not deployed, not production adopted,
and not M3 or Strata 1.0 certification.

- **Starting `main`:** `ea9b47a1bb49491ee92b840ae75f3209ce4384ea` (merge of PR #122), branch
  `feat/analog-request-observability-v08`. `@strata-sc/analog` was 0.7.0, `@strata-sc/core` 0.2.2,
  `@strata-sc/server-components` 0.7.0, `@strata-sc/h3` 0.1.0. One minor Changeset targets
  `@strata-sc/analog` (expected 0.8.0); no version is edited by hand and nothing is published, tagged or
  deployed from the branch. The pending Server Components 0.8.0 Changeset (and its open release PR #123) is not
  absorbed or touched. Issue #117 (publishing is not gated on the aggregate CI `Verify` of the same commit) is
  deliberately left alone and remains a release-safety blocker.
- **Runtime tuple (unchanged, the lockfile is not modified):** Analog platform 2.7.2, `@analogjs/router` 2.8.1,
  Nitro 2.13.4, h3 1.15.11 (Nitro 2's H3 v1), Vite 8.3.0, Angular 22.1.7 (workspace fixture) / 22.2.3 (packed
  consumers), TypeScript 6.0.3 and 5.9.2, Wrangler 4.135.0 with workerd 1.20260918.1 and compatibility date
  2026-09-21. The H3 v2 adapter `@strata-sc/h3` is not involved.

## The problem

Strata's middleware seams finish at different moments. A handler may return before its interceptors have unwound,
before its cleanups ran, and, for a `streamResponse()`, before the body was produced. An interceptor is therefore
not a reliable completion hook, and a log written when the handler returns cannot describe the invocation. The
feature exposes one narrow, structured fact per Strata-owned invocation and leaves recording it to the application.
It is not an observability SDK, a Nitro hook or a transport telemetry source.

## Public API

```ts
registerControllers(router, controllers, {
  onRequestSettled(observation) {
    /* consumer-owned logging, metrics, tracing */
  },
});
```

The option is a function or absent (anything else is a `StrataAnalogConfigurationError` at registration).
Exported types: `StrataAnalogRequestObservation`, `StrataAnalogRequestObserver`,
`StrataAnalogRequestOutcome`, `StrataAnalogRequestPhase`.

| Field          | Type                                 | Meaning                                                                                  |
| -------------- | ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `route`        | `StrataAnalogRouteInfo`              | registered `method`, `path` (template), `controller`, `handler`; the frozen route object |
| `outcome`      | `StrataAnalogRequestOutcome`         | one of nine finite values (below)                                                        |
| `status`       | `number \| undefined`                | only a status Strata itself produced; otherwise `undefined`                              |
| `phase`        | `guards\|execution\|cleanup\|stream` | where the invocation ended                                                               |
| `streaming`    | `boolean`                            | the invocation returned an owned `streamResponse()`                                      |
| `cleanup`      | `"completed" \| "failed"`            | whether every cleanup callback completed                                                 |
| `invocationMs` | `number`                             | handler start → guards, interceptors and handler settled, before cleanup                 |
| `elapsedMs`    | `number`                             | handler start → this observation, after cleanup                                          |

Outcomes: `completed`, `guard-denied` (401/403), `input-rejected` (400/413/415), `application-error`
(`StrataAnalogHttpError` status), `failed` (anything else thrown; status unknown), `cleanup-failed`,
`stream-completed`, `stream-failed`, `stream-cancelled`. `status` is not an outcome classifier: a returned
value or `Response`, an unexpected failure, a stream and a cleanup failure all report `undefined`, because Nitro
owns that conversion and Strata would be guessing (never an invented `500`). `cleanup-failed` takes precedence
over every other outcome: a successful handler with failing cleanup is not a successful invocation, and a
handler failure plus a cleanup failure is reported once, as `cleanup-failed`, matching the `AggregateError` that
propagates.

## Timing and sequencing

- The observation is built and delivered once, after `CleanupScope.close()` settled (LIFO, `AggregateError`
  semantics unchanged), in the request's own call stack, before the handler's result or error is returned to
  Nitro. It is guarded by a per-invocation flag, so a second delivery is impossible.
- A guard denial is reported after its cleanups, with no controller constructed. Input rejection and
  `StrataAnalogHttpError` are classified from the error classes Strata already translates into responses.
- Durations use `globalThis.performance.now()`, a monotonic clock on Node and workerd. No wall-clock timestamp is
  exposed. On Cloudflare Workers the clock only advances across I/O, so CPU-only work can read `0`.
- For a stream, `invocationMs` ends when the stream was returned and `elapsedMs` is the full observed body
  lifetime; the stream lifetime is never labelled handler duration.

## Streaming

`streamResponse()` ownership already binds the invocation's cleanup scope to the body until the first of
completion, producer failure or cancellation. The observation hooks that single release: the scope is closed,
then `stream-completed`, `stream-failed` or `stream-cancelled` is delivered (or `cleanup-failed` if a cleanup
failed), and only then is the stream ended for its consumer. Consequences, all tested:

- Nothing is reported when the handler returns. No body is read, teed or counted; there is no per-chunk work.
- An interceptor that replaces a stream leaves it unclaimed; the replacement yields an ordinary `completed`
  observation (`streaming: false`) and the abandoned stream is never reported.
- A derived `HEAD` over a streamed `GET` cancels the body, so it is reported as `stream-cancelled`, after cleanup.
- **Unsupported:** client disconnect. Neither Nitro adapter propagates it to the body, so a stream the transport
  never reads or cancels, or whose finite producer outlives the client, is reported only if and when the body
  reaches a terminal outcome. A producer that outlives a disconnected client is reported `stream-completed` when
  it ends; an unconsumed stream is never reported. There is no timeout, no abandonment heuristic and no claim of a
  disconnect event.

## Observer failure policy

The callback is synchronous. Its return value is ignored and never awaited. Anything it throws is caught; a
returned thenable is detached and its rejection discarded, so nothing can become an unhandled rejection. The
response, the expected HTTP error, the handler's own exception and a cleanup `AggregateError` are therefore
unchanged, other requests are unaffected, and no cleanup runs twice. Asynchronous export is deliberately not
supported: Strata keeps no queue and has no lifetime mechanism on Cloudflare Workers to deliver background
telemetry (applications can use their runtime's own, e.g. `waitUntil`, from inside the callback). Discarding the
callback's own errors is a trade-off: a broken observer is silent, so applications should guard it themselves.

## Confidentiality

The observation is assembled only from the registered route, a finite classification, booleans and two numbers.
It holds no URL, query, parameter value, header, cookie, body, context, error object, message, cause, stack,
validation issue or chunk. Tests send synthetic canaries in the query, route parameter, `Authorization` and
`Cookie` headers, request bodies, validation input, thrown messages, causes, aggregate cleanup errors, stream
failure messages and tenant-shaped route parameters, and assert that none appears in the serialized observation
or the exact field set. Overlapping `alpha`/`beta` requests never mix. This is not a guarantee about what an
arbitrary callback logs from other sources.

## Qualification

- **Unit (`packages/analog/src/request-observation.test.ts`, 26 tests, on a real h3 router):** plain data,
  native `Response`, `jsonResponse()`, `noContent()`, all five methods, guard 401/403, validation 400/413/415,
  application error, unexpected error, factory rejection, invalid interceptor and guard decision, interceptor
  wrapping and replacement, LIFO cleanup, one/several cleanup failures, handler plus cleanup failure, owned stream
  completion, failure after partial output, cancellation, stream cleanup failure, interceptor replacement of a
  stream, never-consumed stream, derived `HEAD`, throwing and asynchronous observers, overlapping requests,
  confidentiality, exact field set, native routes unobserved. Negative controls: letting observer errors escape
  fails the two isolation tests; emitting a stream outcome at handler return fails six stream tests.
- **Real fixture (`pnpm test:analog-observability`):** a consumer-owned structured logger on the real Analog
  fixture, with observations and the cleanup that preceded them recorded by an unobserved route, so the observer
  is verified independently of the HTTP response. On Node production, the Vite dev server and local workerd:
  ordinary, expected-error (`409`), unexpected (5xx, status unknown) and owned-stream requests answer exactly as
  before, produce one observation each, the cleanup precedes the observation, the stream observation follows the
  body, secrets from the query, route parameter and headers are absent, native Nitro routes add nothing, and
  the real compiled `serverFn` still answers as in `test:analog-streaming` (workerd `serverFn` stays the
  documented upstream NO-GO). On Node and dev the structured line reaches the process output; Wrangler's captured
  output does not carry a Worker's `console.log`, which is recorded, not asserted.
- **Packed consumer (`pnpm test:package-consumer`):** the new exports compile under strict TypeScript 6 (and the
  existing 5.9 matrix) with `skipLibCheck: false`, and run from the installed tarball on an H3 v1 router;
  `request-observation.d.ts` ships and no transport type leaks.
- **Not measured:** observation overhead. Disabled, the handler performs one `undefined` check and allocates
  nothing; enabled, it allocates one tracker and one frozen object per invocation, with no extra body read.

## Copyable example

```ts
// src/server/plugins/strata.ts
import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { UsersController } from "../strata/users.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController], {
    onRequestSettled(o) {
      console.log(
        JSON.stringify({
          event: "strata.request",
          route: `${o.route.method} ${o.route.path}`,
          outcome: o.outcome,
          status: o.status ?? null,
          streaming: o.streaming,
          cleanup: o.cleanup,
          elapsedMs: o.elapsedMs,
        }),
      );
    },
  });
});
```

## Not covered

API boundary 404/405/`OPTIONS` decisions (they run no controller; observing them would need its own contract),
native Nitro routes, Analog server functions, client disconnect, HTTP status of returned values, request
correlation, tracing, metrics aggregation, a deployed Cloudflare Pages project, and hosted CI. Outstanding M3,
M4 and Strata 1.0 blockers are unchanged ([roadmap](../ROADMAP.md), [release criteria](../RELEASE-1.0.md)).
