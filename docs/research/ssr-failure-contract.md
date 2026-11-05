# SSR failure contract: from fixture pattern to an opt-in Strata entry

Date: 2026-11-05. Branch `feat/ssr-failure-contract`. Starting main:
`8d97e797ff52bf8a7c27052cd67f91aed5137133` (PR #172 merged). The final implementation SHA is the head
of the pull request that carries this report.

Evidence levels, never interchangeably: IMPLEMENTED, UNIT, LOCAL NODE, LOCAL WORKERD, PACKED CONSUMER,
PUBLISHED REGISTRY, HOSTED CI, DEPLOYED, REAL APPLICATION.

## What changed

PR #172 showed that an unexpected Angular SSR failure can become an honest HTTP 500 through public
Angular/Analog APIs, but the code lived in the external fixture
(`tests/full-stack-package-consumer/fixture/src/app/render-failure-status.ts`) and every consumer would
have had to copy it. This change moves the pattern into a small, opt-in package entry and requalifies it
through the installed tarball:

| Item                                   | Change                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@strata-sc/server-components/ssr`     | New subpath: `provideStrataSsrFailureHandler`, `withStrataSsrFailureContract`, `STRATA_SSR_FAILURE_DOCUMENT` and five types                                                                               |
| Behaviour added to the PR #172 pattern | headers set by the failed render are dropped/restored; one report per failed request (de-duplicated); configurable reporter and static document; native `ErrorHandler` behaviour outside a wrapped render |
| Full-stack fixture                     | imports the entry from the installed package; three new probe modes (`rejection`, `header`, `handled`)                                                                                                    |
| Packed Server Components consumer      | becomes the **not-opted-in** control (native HTTP 200 pinned)                                                                                                                                             |
| Registry / frozen / A/B modes          | published tuples that predate the entry run the same checks on the consumer-owned recipe (version-gated bridge)                                                                                           |
| Public API inventory                   | `./ssr` added to `tools/package-consumer/public-api.json`                                                                                                                                                 |

Rendering is not redesigned: Analog's `render()` and Angular's `renderApplication` run unchanged; the
wrapper only decides, after the buffered document exists, whether to answer it.

## Why `@strata-sc/server-components`, and why a subpath

- `@strata-sc/core` must not gain Angular or Analog dependencies; `@strata-sc/analog` is the controller
  adapter and has no Angular dependency either. A consumer that uses only controllers is untouched.
- `@strata-sc/server-components` already requires `@angular/core` as a peer and owns the SSR
  contract of Server Components, so the entry adds **no peer dependency**.
- It is a separate subpath (like `/navigation`), so nothing in the root entry or the browser graph
  references it, and an application that does not import it is byte-for-byte unaffected. The package
  boundary test enforces: imports only `@angular/core`; no `globalThis`/`process`/storage; the only
  module state is one `WeakMap`; unreachable from the runtime and navigation entries.
- It does **not** import Analog. The link between the `ErrorHandler` and the wrapper is the identity of
  the per-request response object: Analog provides `RESPONSE` with `useValue: context.res`
  (`provideServerContext` in `@analogjs/router/server`), and the application passes that public token to
  `provideStrataSsrFailureHandler(RESPONSE)`. No private Analog or Angular symbol is used.

## Public API

```ts
// app.config.server.ts
providers: [provideServerRendering(), provideStrataSsrFailureHandler(RESPONSE)];

// main.server.ts
export default withStrataSsrFailureContract(render(App, config), { report, failureDocument });
```

`withStrataSsrFailureContract` is generic over the render context (`{ readonly res: StrataSsrResponse }`)
and returns the exact type it receives, so Nitro's renderer accepts the wrapped function unchanged; this
is type-checked against Analog's real `render()` and `RESPONSE` under TypeScript 6.0.3 and 5.9.2.
`StrataSsrResponse` is structural (`statusCode`, `setHeader`, optional `getHeaderNames`/`getHeader`/
`removeHeader`); Node's `ServerResponse` and the workerd shim satisfy it.

## The supported contract

Buffered SSR only. For a request rendered through the wrapper, before the response is committed:

| Situation                                                     | Result                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Healthy render                                                | unchanged (status, headers, complete HTML, hydration state)                               |
| Application-set status (a not-found page setting 404)         | unchanged: still the application's 404 page                                               |
| Error the application catches itself                          | unchanged: it never reaches `ErrorHandler`                                                |
| Unexpected error reported to `ErrorHandler` during the render | HTTP 500, `cache-control: no-store`, static document, render-set headers removed/restored |
| Rejected render (bootstrap, initializer, non-`Error` reason)  | the same                                                                                  |
| Reporting                                                     | exactly one call per failed request; default line names classes and phase only            |

Failure state is created when the wrapper starts a render, keyed by that request's response object, and
deleted before the wrapper returns. A recorded error from another request's injector is not this
request's failure. Outside a wrapped render (browser, late errors, a handler without the wrapper) the
handler delegates to Angular's native `ErrorHandler`.

**Not covered** (stated in the README): streaming SSR (`renderStream`) and anything after the response is
committed; hydration or interaction errors in the browser after delivery; a duplicated installation of the
package (the provider and wrapper would not share state and the request fails open to native HTTP 200).

### The five error kinds, distinguished

| Kind                             | Owner and result                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Handled application error        | the application catches it and renders its fallback; HTTP 200 (or its own status); the contract is not involved |
| Expected HTTP error              | the application sets the status through `RESPONSE` (404 page, the 503 expected-service recipe); kept as is      |
| Unexpected rendering failure     | reaches `ErrorHandler` or rejects the render; with the opt-in contract: generic 500/no-store; without: HTTP 200 |
| Build-time server-only violation | the Vite plugin fails the build; nothing is deployed, no runtime contract applies                               |
| Hydration error after delivery   | browser-side, after the 200 was sent; Strata's per-host hydration transaction and the application's handler     |

### What remains application-owned

Opting in; choosing the response token; the failure document's content (static only); where reports go
and how `errors` (private) are redacted; 404 and other expected statuses; expected-service fallbacks;
any second `ErrorHandler` behaviour (the provider replaces the application's `ErrorHandler`).

## Failure scenarios proven

All through the installed tarball in the external full-stack consumer (PACKED CONSUMER), on Nitro
`node-server` (LOCAL NODE) and the Cloudflare Pages build under `wrangler pages dev` (LOCAL WORKERD):

| Scenario                                         | Fixture probe                                          | Node                         | workerd      |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------------------- | ------------ |
| Healthy SSR, complete HTML                       | `/render-failure/none`, `/products/42`                 | 200                          | 200          |
| Server Component constructor throws              | `constructor`                                          | 500                          | 500          |
| Injected service throws                          | `service`                                              | 500                          | 500          |
| Template binding throws after partial output     | `template`                                             | 500                          | 500          |
| Serialization / client-boundary refusal          | `boundary`                                             | 500                          | 500          |
| Application initialization fails                 | `bootstrap` (synchronous initializer throw)            | 500                          | 500          |
| Unexpected render rejection (non-`Error` reason) | `rejection` (initializer rejects with a string)        | 500                          | 500          |
| Private header written by the failed render      | `header` (`x-render-private`, cacheable cache-control) | 500, header absent, no-store | same         |
| Handled application error                        | `handled`                                              | 200                          | 200          |
| Expected application 404                         | catch-all page setting 404                             | 404                          | 404          |
| Concurrent successful and failing                | 24 overlapping requests                                | each its own                 | each its own |
| Failure then success                             | `/products/42` after the failures                      | 200                          | 200          |

Every failure body equals the generic document (an independent literal in the verifier, so a drift in
the package default fails), contains no `partial-before` text, no `data-strata-*`, no `ng-state`/`ngh`,
and no canary in body or headers. The server log has exactly one `[strata:ssr]` line per failed request
(7 of 7, waited for with a quiet period so a duplicate would be counted), the `string` class for the
non-`Error` rejection, and no private message, stack frame or failing URL.

Negative controls: the log/body predicates are run on synthetic leaky lines (message, stack frame, URL)
and must flag them; unit tests show a reporter that prints `errors` does expose the canary; and the
not-opted-in packed consumer shows Angular's native `ErrorHandler` writing the private message to the
server log, which the same kind of assertion detects.

Not opted in (packed Server Components consumer, LOCAL NODE): a page whose template throws after partial
output answers **HTTP 200** (the documented native limitation), the `/ssr` entry and its document are
absent from that application's server and browser output, and no `[strata:ssr]` line is written.

Preserved in the same opted-in run: hydration and exactly-once island interaction (Chromium), document
navigation, build identity and skew checks, request isolation and authorization matrices, graph
confidentiality (the entry is absent from every browser file and source map and present in the server
graph), the server-only firewall.

## Unit and type evidence

`packages/server-components/src/ssr/failure-contract.test.ts` (UNIT, 14 tests): pass-through, 404
preserved, 500/no-store document, rejection with a non-`Error`, de-duplication and one report, the exact
default log line, a leaky-reporter negative control, header removal/restoration, custom document and
throwing reporter, 40 interleaved concurrent renders, no poisoning of the next request, native fallback
without a wrapped render or without the token, and a foreign injector's error not marking this request.
`package-boundary.test.ts` adds the four entry checks above.

Declarations (PACKED CONSUMER): `src/check/ssr-failure-example.ts` uses every public declaration under
`strict` + `skipLibCheck: false` with TypeScript 6.0.3 and 5.9.2, including two `@ts-expect-error`
refusals (a value instead of a token; a context without `res`). `src/check/ssr-failure-analog.ts`
type-checks the documented Analog integration against Analog's real `render()`/`RESPONSE`; that one
project uses `skipLibCheck: true` because Analog's own declarations reference Nitro and database driver
types the consumer does not install (with `skipLibCheck: false` they fail inside `@analogjs/router`,
`nitropack` and `db0`, not in Strata or consumer code). The public API inventory check (installed
declarations = runtime exports = reviewed baseline) includes `./ssr`.

## Results

Local runs on this branch (macOS, Node 22), all from packed tarballs installed outside the workspace:

| Command                                              | Result                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm --filter @strata-sc/server-components test`    | 18 files / 415 tests pass (14 new contract tests, 4 new boundary checks)                              |
| `pnpm test` (incl. `test:ci`)                        | pass; `test:ci`: 35/35 required commands in 11 mandatory jobs                                         |
| `pnpm test:full-stack-package-consumer`              | PASS, 460 checks, 0 failing (186 s): Node + local workerd + Chromium, TS 6.0.3 + 5.9.2, API inventory |
| `pnpm test:server-component-package-consumer`        | PASS, 271 checks (not-opted-in control included)                                                      |
| `pnpm test:full-stack-multi-isolate`                 | PASS, 88 checks (runs the same failure checks on a second fixture build path)                         |
| `pnpm test:full-stack-adversarial-security:smoke`    | PASS (mutation rejected; fixture byte-identical afterwards)                                           |
| `pnpm test:full-stack-deployed-cloudflare`           | PASS, SOURCE-PACKED, local workerd rehearsal only; `REAL DEPLOYMENT: NOT RUN`                         |
| `pnpm lint` / `format:check` / `typecheck` / `build` | pass (lint: the 5 pre-existing warnings only)                                                         |
| `entwine check` (0.5.1)                              | validation passed                                                                                     |

Development history, kept because it shaped the checks: the first declaration example imported
`@analogjs/router/server` into the `skipLibCheck: false` project and failed inside Analog's own
declarations (Nitro, `db0`), hence the split described above; a too-broad source-map pattern (`/ssr/`)
matched Angular/Analog SSR sources in the not-opted-in app and was narrowed to the Strata entry path with a
positive control.

Hosted results: see [CI timing](#ci-timing) and the pull request.

## Registry, frozen candidate and A/B modes

Those modes install a published tuple. server-components ≤ 0.14.x has no `/ssr`, so the run copies the
consumer-owned recipe (`tests/full-stack-package-consumer/recipes/ssr-failure-contract.ts`, the PR #172
pattern with the same names and behaviour) and points the two fixture imports at it; the declaration
examples and the `./ssr` baseline entry are omitted for that run only. The runner checks that a bridged
install really lacks the entry and that a packed run never bridges, so the bridge cannot hide the API.
Remove the recipe once the frozen candidate and every A/B pair carry 0.15.0+. Not run locally in this
change (Extended suites; see below).

## CI timing

No job, step or command was added; `tools/ci/required-commands.json` is unchanged (35 commands, 11
mandatory jobs, aggregate `Verify`). The new checks run inside suites that already build the same
consumer: the packed full-stack consumer (and its multi-isolate and Cloudflare-rehearsal reuses of the
fixture) issues about 40 more HTTP requests per runtime plus a bounded log wait (at most 5 s, normally
about 0.6 s), and the packed Server Components consumer adds one request and a log wait. No additional
consumer build or install.

Before (main `8d97e79`): PR run 42062487540 9.6 min wall; main push 42071079490 10.9 min including the
website deploy; slowest job "Packed consumer (deployment skew, Cloudflare local workerd)" 9.3–9.4 min;
"Packed consumer (full stack, adversarial smoke, multi-isolate)" 5.9–6.3 min.

AFTER_PLACEHOLDER

## Changeset

`.changeset/ssr-failure-contract.md`: `@strata-sc/server-components` **minor** (new public subpath,
additive, no migration). No other package changes; core and analog are untouched.

## 1.0 criteria affected

- **#15** (render, serialization, navigation and hydration failures): stays **PARTIAL**. Stronger: the
  unexpected-render contract is a Strata API qualified packed on Node and local workerd. Open: no real
  application uses it, it is opt-in rather than default, streaming remains unsupported, and the deployed
  and published-registry qualification of the entry itself waits for a release.
- **#16** (error redaction, leak negatives): evidence added (log redaction with negative controls), status
  unchanged.
- Matrix unchanged: PASS 1, PARTIAL 27, BLOCKED 0, NOT RUN 4. Strata is not 1.0-ready.

## Remaining limitations

- Opt-in: an application that does not adopt it still answers HTTP 200 for an unexpected render failure.
- Buffered SSR only; streaming and committed responses are out of scope.
- Replaces the application `ErrorHandler`; composing with another handler is application code.
- Header restoration needs `getHeaderNames`/`getHeader`/`removeHeader` (Node and the workerd shim have
  them); without them only status and `cache-control` are set.
- A duplicated package copy fails open (native HTTP 200), it does not fail closed.
- Issue #117 is unaffected and stays open.
