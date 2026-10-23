# Analog streaming lifecycle and server-function coexistence (0.7.0 candidate)

Evidence for `streamResponse()` in `@strata-sc/analog` and for a real compiled Analog `serverFn` running next to
Strata. Experimental fixture evidence: locally integrated and packed-consumer qualified, not hosted-CI qualified
when this was written, not deployed, not production adopted, and not M3 or Strata 1.0 certification.

- **Starting `main`:** `279275eafe7519725b8413046335fc91330795d6` (merge of PR #118), branch
  `feat/analog-stream-lifecycle-v07`. The Server Components 0.7.0 release PR (#119) was still open and is not
  touched. One minor Changeset targets `@strata-sc/analog` 0.7.0; no version is edited by hand and nothing is
  published, tagged or deployed from the branch. Issue #117 (publishing is not gated on the aggregate CI `Verify`
  of the same commit) is deliberately left alone.
- **Runtime tuple:** Analog platform 2.7.2, `@analogjs/router` 2.8.1, `@analogjs/vite-plugin-nitro` 2.7.2, Nitro
  2.13.4, h3 1.15.11 (Nitro 2's H3 v1), Vite 8.3.0, Angular 22.1.7 (workspace fixture) / 22.2.3 (packed
  consumers), TypeScript 6.0.3 and 5.9.2, Node 22.23.1, Wrangler 4.135.0 with workerd 1.20260918.1 and
  compatibility date 2026-09-21 (no `nodejs_compat`). The H3 v2 adapter `@strata-sc/h3` and its independent
  declaration blocker are not involved.

## The problem, reproduced

`CleanupScope` closes when the route handler settles. A handler may return a native `Response` whose body is read
later by the transport, so request-scoped resources can be closed before the body has used them. The fixture's
`GET /api/strata/stream/eager` returns an ordinary `Response` over a `ReadableStream` that reads a request-scoped
`ChunkReader`. On the Node production server the body is

```text
eager:0;eager:1;eager:closed-before-use;
```

and the reader's counters show it closed once, before the last chunk was produced: the cleanup ran while the body
was still being read. The same check passes on workerd. This is the unchanged contract for every handler that does
not opt in (`pnpm test:analog-streaming`, "an ordinary streaming Response still has its scope closed before the body
is read"). Because every buffered `Response` also exposes a `ReadableStream` body, ownership is never inferred from
a response's shape.

## What Nitro and H3 do with a returned `Response` (pinned tuple)

Read from the installed H3 1.15.11 source and confirmed on the real routes:

- **Node.** `sendWebResponse` copies status and headers, then `sendStream` does
  `stream.pipeTo(new WritableStream({ write(chunk) { res.write(chunk) } }))` and ends the response when the pipe
  resolves. The Web Stream is preserved and read incrementally; there is no backpressure and **no hook ties
  `res` closing to the body**: a client that goes away neither cancels the body nor aborts the pipe. A body that
  errors rejects `pipeTo`, Nitro's error handler then tries to set headers on a response that was already sent
  (`ERR_HTTP_HEADERS_SENT` in the server log), and the connection is **left open with no end**.
- **Cloudflare Pages preset.** The Nitro worker runs the app on a mock Node request/response with no socket, so
  `sendStream` returns without piping and Nitro assembles the `Response` itself. A gated body is **buffered**:
  nothing arrives until the producer finishes. A body that fails mid-way comes out as an empty `200`.
- Completion is observable through public Web Streams only (the producer finishing, erroring, or `cancel()` being
  called on the body). Strata uses nothing else: no Nitro/H3 private property, no monkey-patch, no timer.
- The pinned adapter does not expose a client-abort signal (see
  [the 0.5.0 investigation](analog-http-contract-v05.md#cancellation-investigation)), so none is invented.

A **control route** (`GET /api/native-stream`, a native Nitro handler with no Strata code) is run first by
`pnpm test:analog-streaming` so the transport is classified on its own: Node and the dev server **incremental**,
workerd **buffered**. The Strata checks then assert the matching suite, so a transport difference is a recorded
result and not a different test.

## Ownership model and public API

One addition, `streamResponse(body, init?)`:

```ts
streamResponse(body: AsyncIterable<string | Uint8Array>, init?: ResponseInit): Response
```

It is necessary because the handler must tell the adapter, explicitly, that the response's lifetime extends the
invocation, and it must hand over a response whose completion Strata can observe. It is a plain native `Response`
(over a pull-based `ReadableStream` with `highWaterMark: 0`, so never read ahead), not a new abstraction over Web
Streams. The body is an async iterable, typically an `async function*`; the producer starts only when the first
chunk is pulled.

1. `streamResponse()` records an `ownership` in a `WeakMap<Response, …>`; a response is only owned if it came from
   the helper.
2. After the handler **and every interceptor** have settled, `createRouteHandler` calls `claimStreamResponse`. If the
   final result is an owned, unclaimed, not-cancelled response, the invocation's `CleanupScope` is bound to it and
   the route handler returns **without closing the scope**. Anything else keeps the eager `scope.close(...)`.
3. The scope closes once, on the first terminal outcome (the body completing, its iterable throwing, or the body
   being cancelled); later outcomes observe the same settlement.

Cleanup sequencing on a terminal outcome: stop the producer (`iterator.return()`, so its `finally` runs first), then
run the cleanups, last registered first and awaited, each failure collected (`CleanupScope.close`, unchanged).

| Outcome                   | Producer stopped | Cleanups | What the stream does                                                |
| ------------------------- | ---------------- | -------- | ------------------------------------------------------------------- |
| Body completes            | already done     | once     | closes; **errors instead** if a cleanup failed                      |
| Iterable throws           | already done     | once     | errors with the error, or `AggregateError([error, …cleanupErrors])` |
| Consumer cancels the body | `return()`       | once     | `cancel()` resolves, or rejects with the cleanup error(s)           |
| Invalid chunk type        | `return()`       | once     | errors with a `TypeError`                                           |
| Cancel races completion   | whichever first  | once     | the second outcome observes the first's settlement                  |

Error precedence is the existing `CleanupScope` rule: the body error alone when every cleanup succeeded, a single
cleanup error alone after a clean body, otherwise an `AggregateError` with the body error first and the cleanup
errors in the order they ran. Strata writes no message, cause or stack into a response body.

### Interceptors, guards, validation

- Passing the same `Response` through, and reading `headers`/`status`, keeps ownership. Entry and exit order, the
  one-`next()` rule and "no live downstream after settling" are unchanged.
- **Replacing** the response (a new `jsonResponse`, or `new Response(original.body, original)`) hands ownership to
  nobody: the scope closes eagerly, as for any request, and the abandoned body fails with a
  `StrataAnalogConfigurationError` if anything pulls it. Pulling before the adapter owns it (an interceptor reading
  the body) fails the invocation the same way, and returning one owned response from two invocations fails the
  second. A body cancelled before the claim is released eagerly.
- A denied request never constructs the controller or starts the stream; an invalid-input response is a plain
  non-streamed response and closes eagerly (tested with a Standard Schema validation failure).
- A derived `HEAD` cancels the body, which releases the resources once.

### Never consumed, and the supported release path

The scope is held until the body ends or is cancelled, and nothing else releases it: Strata adds no global timer
and no registry. On the pinned transports the release path is real: Node pipes the whole body (so a finite body
always ends) and workerd drains it. A transport that never reads or cancels an owned body would retain its
resources: this is the documented boundary, and the reason the contract is opt-in and asks for finite bodies.

## Results

Evidence levels: **unit** (`packages/analog/src/stream-lifecycle.test.ts`), **local** (real Analog/Nitro fixture),
**packed** (tarballs installed outside the workspace). Hosted CI is recorded separately below.

### Unit tests (27 new tests, 200 in the package)

Deterministic barriers (deferred promises and counters), no sleeps, intended failure reason asserted. They cover:
multi-chunk delivery across a barrier with the resource open between chunks, no read-ahead, exactly-once release,
LIFO and asynchronous cleanups, a failure after the first chunk and before any chunk, consumer cancellation (the
producer's `finally` runs first), cancellation racing completion, stream error versus cleanup error (`AggregateError`,
producer first), several cleanup failures (all attempted), an invalid chunk, interceptor pass-through, replacement,
rebuilt response, body read before ownership, the same response returned twice, cancellation before the claim,
guard denial (no construction, no stream), Standard Schema validation failure (non-streamed, eager, canary absent),
a handler failing before it returns a stream, eager cleanup for a plain JSON handler and for an ordinary `Response`
(including an ordinary `ReadableStream` body), concurrent streamed requests with separate resources (including
cancelling one without touching the other), and a private canary absent from the body and status line. Mutation
check: neutralizing the claim in `register-controllers.ts` fails 16 of the 27.

### Node production, Vite dev server, local workerd (`pnpm test:analog-streaming`)

| Observation                                                                    | Node prod                            | Vite dev      | workerd (local)                  |
| ------------------------------------------------------------------------------ | ------------------------------------ | ------------- | -------------------------------- |
| Transport (native control route)                                               | incremental                          | incremental   | **buffered**                     |
| First chunk arrives while the producer is blocked on another request's barrier | yes                                  | yes           | **no (unsupported)**             |
| Reader open while the body is in flight, released once, before end             | yes                                  | yes           | released once after the body     |
| Two overlapping streams keep separate readers                                  | yes                                  | yes           | yes                              |
| Ordinary streaming `Response` keeps the eager contract                         | yes                                  | yes           | yes                              |
| Guard denial: 403, no reader, no stream                                        | yes                                  | yes           | yes                              |
| Interceptor replacement: eager contract                                        | yes                                  | yes           | yes                              |
| `HEAD`: headers only, reader released                                          | yes                                  | yes           | yes                              |
| Producer failing after the first chunk                                         | first chunk, then **no end**         | same          | `200`, empty body, "done"        |
| Cleanup failing after the last chunk                                           | all chunks, **no clean end**         | same          | same as the native failure       |
| Private error message in the response                                          | absent                               | absent        | absent                           |
| Client disconnect while blocked                                                | **retained until the producer ends** | same          | retained until the producer ends |
| Reader of a disconnected client, once the producer ends                        | released once                        | released once | released once                    |
| Canary and Strata adapter code in the browser output                           | absent                               | n/a           | absent (`_worker.js` excluded)   |

The "gated body" is a producer that polls a flag another request sets (`POST /api/strata/stream/release`). A shared
promise is not used: workerd cancels a request whose promise only a different request can settle ("the Worker's
code had hung"), which an earlier version of the fixture hit.

Read these results as the transport's, not Strata's: for a failing body, Strata's outcome equals the native
control's outcome on every runtime (asserted), and the reader is released exactly once. The consequences are
documented, not repaired: on Node a client cannot tell a failed stream from a slow one except by its own timeout,
and on workerd it cannot tell a failed stream from an empty success.

### Packed consumers (tarballs, outside the workspace)

- `pnpm test:package-consumer` (TypeScript 5.9.2, strict, `skipLibCheck: false`, NodeNext, H3 v1 router): a
  request-scoped `OrderCursor` outlives the handler for two overlapping streams with separate cursors, closes once
  after each body, and a client that drops releases its cursor when the finite producer ends. The declaration gate
  (no DOM lib: `Response`/`ReadableStream` come from `@types/node`) compiles `streaming.controller.ts`.
- `pnpm test:full-stack-package-consumer` (TypeScript 6.0.3 and 5.9.2 declarations, `skipLibCheck: false`, ESM
  exports, dependency graph, Node production build and server, Cloudflare Pages build and local workerd): the shared
  `observeStreaming` suite runs on the consumer's Node server (incremental) and local workerd (buffered), plus the
  `stream-example.ts` usage example under both compilers.
- `pnpm test:analog-packed-di-consumer` (Node): six overlapping streamed responses each read their own Angular
  request injector for every row after the handler settled (`destroyed: false`); each injector, request identity and
  controller is destroyed exactly once after the body; a denied streamed request creates no injector.

The realistic usage example is the README's `OrdersController` (a request-scoped cursor that produces several
chunks) and is compiled in the consumer. No transport-specific peer dependency enters the declaration graph.

### Real Analog `serverFn` coexistence

Analog 2.7.2 syntax, read from the installed packages: `*.server.ts` under a subdirectory of `src`, a directly
exported `export const fn = serverFn(handler | schema, handler | config, handler)` from `@analogjs/router/server`,
dispatched at `/_analog/fn/<id>` with `id = sha256("<root-relative path>#<export>").slice(0, 16)`; GET for an
input-less function, POST with a JSON body otherwise. The fixture's `strata-compat.server.ts` defines one of each
(a handwritten Standard Schema input).

On **Node (production and dev)**, in the same application as Strata controllers, native Nitro routes, the API
boundary and Server Component SSR: the input-less function answers GET with its return value; the POST function
preserves its argument and return contract; invalid input answers Analog's `400` with its issues, not Strata's
envelope; an unknown id is Analog's `404` and a wrong method Analog's `405`, neither shadowed by the boundary (the
dispatch route is outside `/api`); six concurrent POSTs keep their own inputs; `/api/native`, a Strata controller
route, the boundary's JSON `404` and the Server Component page all still answer; the server-only string and the
adapter are absent from the browser output. Hydration is exercised by `pnpm test:server-components` and its siblings
against the same fixture.

Two findings, both outside Strata:

1. **POST dispatch failed until `h3` was declared for `@analogjs/router`.** The package imports `readBody`,
   `getRouterParam` and `eventHandler` from an undeclared `h3`; with this workspace's hoisted H3 v2 (from
   `@strata-sc/h3`) the call throws `event.req.headers.get is not a function` and every POST answers
   `400 Malformed request body` (GET is unaffected). The workspace already declared `h3: ^1.15.11` for
   `@analogjs/vite-plugin-nitro` for the same reason; `pnpm-workspace.yaml` now does so for `@analogjs/router`. A
   consumer with H3 v2 hoisted would see the same failure.
2. **workerd: NO-GO.** The Cloudflare preset build fails first on the generated dispatch module's
   `import "zone.js/node"` (a zoneless app has no `zone.js`; Node tree-shakes the import, workerd forbids externals):
   the fixture aliases it to an empty module for that one build. The build then succeeds and **every** `serverFn`
   answers `500` (`EvalError: Code generation from strings disallowed`), because `@analogjs/router/server` ships
   unlinked and needs Angular's JIT. This is the same limitation as Angular DI on workerd
   ([SPEC-003](../specs/003-analog-request-lifecycle-angular-di.md)); Strata, native routes, the boundary and SSR keep
   working there. The 500s are pinned by the suite, so it fails if workerd ever starts to run them.

Strata adds no wrapper around `serverFn` and no shared injector.

## Remaining NO-GO conditions

- **Client-disconnect cancellation** on both runtimes: the body is never told, so a streamed body that does not end
  is not released, and on Node keeps producing into a closed socket. No signal is exposed and none is invented.
- **Incremental delivery on Cloudflare Pages** (`cloudflare-pages` preset): the body is buffered. Delivered complete,
  released once, but not early.
- **A client-visible failure signal** after a body fails mid-stream, on both runtimes (Node: open connection;
  workerd: empty `200`). The status cannot be rewritten after commitment.
- **`serverFn` on workerd** (Angular JIT), and POST `serverFn` with an H3 v2 hoisted next to Analog.
- A **cleanup failure while cancelling via `HEAD`** is not observable (the boundary discards the cancellation
  result); the cleanups still ran.
- Not exercised: a deployed Cloudflare Pages project (local Wrangler is not deployed qualification), tenant
  isolation beyond the synthetic fixtures, H3 v2, production traffic, abort/timeout cleanup beyond the above.

## Release readiness

`@strata-sc/analog` 0.7.0 adds one public function and keeps every existing contract. It is implemented, unit tested,
locally integrated on Node (production and dev) and local workerd, and packed-consumer qualified on Node and
workerd. It is not hosted-CI qualified until the pull request's Actions pass, not deployed qualified, and not
production adopted. M3 stays open: the streaming lifetime is delivered, but cancellation, a failure signal, deployed
runtime evidence and real-application adoption are not, and `serverFn` on workerd is NO-GO. Strata 1.0 is not
claimed.

## Verification matrix

Filled in from the final local run on the branch head; see the pull request for hosted results.

| Check (local, branch head before commit)                                                                                                                                        | Result                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `build`, `lint`, `typecheck`, `test` (incl. `test:release`, `test:performance-tools`), `format:check`, `changeset status`                     | PASS                                                 |
| `test:analog` (114 checks), `test:analog-streaming` (Node, dev, workerd)                                                                                                        | PASS                                                 |
| `test:package-consumer`, `test:analog-packed-di-consumer`, `test:full-stack-package-consumer`                                                                                   | PASS                                                 |
| `test:server-components`, `-navigation`, `-defer`, `-server-only`, `-security`, `-request-context`, `-authorization`, `-failures`, `-ssr-response`, `-dev`, `-package-consumer` | PASS                                                 |
| `test:server-components:cloudflare`, `test:full-stack-deployed-cloudflare` (local workerd rehearsal, no deployment)                                                             | PASS                                                 |
| `test:www:server-components`, `test:relay:server-components`, `www:build:cloudflare`                                                                                            | PASS                                                 |
| Website Playwright e2e against a fresh production server on an isolated free port                                                                                               | PASS (2 of 2)                                        |
| Entwine `check` and `build` (0.5.1, as in `entwine.yml`)                                                                                                                        | see below                                            |
| `test:server-components:deployed-cloudflare`, `test:server-component-registry` consumers, real Cloudflare deployments                                                           | NOT RUN: need published packages or credentials      |
| `test:consumer:types` (SPEC-002, H3 v2 declarations)                                                                                                                            | KNOWN UPSTREAM BLOCKER, unrelated to Analog, not run |
| `test:full-stack-performance*` (extended workflow)                                                                                                                              | NOT RUN: extended, informational                     |
