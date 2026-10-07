# Server Component failure and recovery

Date: 2026-10-07. Baseline: `main` at `c25e11c` (PR #50 merged). Scope: the contract that is actually
supported today, **buffered SSR + document navigation + `[strataClient]` hydration**, on Nitro
`node-server` and local workerd. Not qualified here: Angular Router navigation into a Server
Component subtree (NO-GO, unchanged), streaming SSR, dev/HMR.

Command: `pnpm test:server-component-failures` (CI step "Server Component failure and recovery").
Fixture routes: `/server-component-failures` (three independent hosts A, B, C, nine islands) and
`/server-component-failure/:mode` (one failing Server Component). Harness: `tools/server-components/lib/failures.ts`
on top of the existing `harness`, `leak-scan`, `security` and `wrangler` libraries.

## Resolved tuple

| Package                                                                    | Version                       |
| -------------------------------------------------------------------------- | ----------------------------- |
| node                                                                       | 22.23.0                       |
| `@angular/core`, `common`, `compiler`, `router`                            | 22.1.7                        |
| `@angular/platform-browser`, `@angular/platform-server`                    | 22.2.1                        |
| `@analogjs/platform`, `@analogjs/vite-plugin-angular`, `@analogjs/router`  | 2.7.2                         |
| nitropack (resolved from `@analogjs/platform`), vite (fixture), typescript | 2.13.4, 8.3.0, 6.0.3          |
| playwright (Chromium)                                                      | 1.62.1                        |
| workerd                                                                    | Wrangler's, compat 2026-09-21 |

`@strata-sc/server-components` stays `0.0.0`, `private: true`. `@strata-sc/core` and `@strata-sc/analog`
are untouched. No Changeset.

## Failure taxonomy

Six cases, each with its own result. They are never merged.

| #   | Case                                    | Owner of the failure                                    | Result                                                                                                         |
| --- | --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A   | Server render failure                   | Angular / Analog (a Server Component throws)            | HTTP 200; empty outlet (construction) or half-rendered component (template); ErrorHandler once; no recovery    |
| B   | Boundary serialization failure          | Strata (protocol v1 rejects the value)                  | HTTP 200; rest of the component renders; the boundary host has no `data-strata-props`; ErrorHandler once       |
| C   | Browser boundary preflight failure      | Strata (`StrataIslandHost`)                             | That host is entirely inert, SSR DOM kept; ErrorHandler once; sibling hosts hydrate                            |
| D   | Browser hydration commit failure        | Strata owns the transaction, the app owns the component | Islands this commit created destroyed, views detached, SSR hosts restored; ErrorHandler once; siblings hydrate |
| E   | Island error after successful hydration | Angular / the application                               | Normal Angular error handling; Strata does nothing                                                             |
| F   | Navigation to a failing document        | Angular / Analog, per request                           | New document, new realm, same A/B result; Back and re-entry are fresh lifecycles                               |

## Failure ownership: one host = one hydration transaction

`StrataIslandHost` is Strata's. For one Server Component host it discovers every boundary, validates all
of them, then commits all of them (`createComponent`, `setInput`, `attachView`). Fail-closed
"all or nothing" is **per host**, not per page: the page is not one hydration plan, and a failure in
host B never stops host A or host C.

## ErrorHandler integration: no runtime change, because Angular already does it

The preferred design was `try { plan; commit } catch (e) { ErrorHandler.handleError(e) }`. The installed
Angular (22.1.7) already does that per callback, in public, observable behaviour. `AfterRenderImpl.execute`
(`_debug_node-chunk.mjs`) runs every `afterNextRender` callback in its own `try/catch`: on a throw it
marks that sequence as errored (it never runs again) and calls `ErrorHandler.handleError(err)`
**once, without rethrowing**. `StrataIslandHost` registers its work with `afterNextRender`, so:

- the Strata-owned failure (preflight `StrataBoundaryError`, or a component `Error` from commit) reaches
  the application's `ErrorHandler` exactly once, after Strata has rolled back;
- the throw does not propagate past the callback, so the other hosts' callbacks (their own sequences) still run;
- a custom `ErrorHandler` that itself throws is that consumer's decision; Angular does not catch it;
- Angular's default handler logs to the console, so the failure is never silent.

Adding our own `try/catch` would call `handleError` from the same place for the same error and change
nothing observable, so the runtime is **not changed** for this. Public APIs only (`ErrorHandler`,
`afterNextRender`, `createComponent`, `ComponentRef`, `ApplicationRef`); no `ɵ` API. Strata registers no
`ErrorHandler` of its own and never replaces the application's. The gate pins the behaviour with a
DI-based fixture `ErrorHandler` (`provideErrorProbe`, `src/probes`, extends Angular's and delegates to
it), so an Angular upgrade that changes it fails CI.

**One runtime change was needed, for error-message safety.** The preflight error for invalid JSON
embedded the engine's `JSON.parse` message. Engines differ: V8 today reports a position; others
(and older V8) quote part of the payload. A payload fragment in an error message breaks the
"selector, boundary position, phase, reason only" rule. `boundary-protocol.ts` now reports
`data-strata-props is not valid JSON.` and never repeats the engine text (unit test: a `JSON.parse` stub
whose message contains the payload). Protocol v1 and the DOM surface are unchanged. `islands.ts` gained a
comment only.

## A. Server render failure (buffered SSR)

`/server-component-failure/{constructor,service,template}`; control `/none`.

| Mode          | Node (Nitro)                                                                                                                                                                                          | workerd (Wrangler Pages) |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `constructor` | HTTP 200 `text/html`, 890 B; **empty router outlet** (`<router-outlet></router-outlet><!---->`)                                                                                                       | identical body; HTTP 200 |
| `service`     | identical to `constructor` (an injected provider throws)                                                                                                                                              | identical                |
| `template`    | HTTP 200, 2102 B; **half-rendered component**: text before the throw kept, bindings after it empty (`<p data-failure-tail=""><!--ngetn--></p>`), the island host has **no** `data-strata-*` attribute | identical                |

Common to all three, on both runtimes:

- exactly one `ErrorHandler.handleError` call on the server per request (`Error`); the original error and
  stack are in the operator log only;
- the public body and headers contain no message, stack frame or sensitive path;
- no partial Server Component HTML in the construction cases; in the template case the partial HTML
  carries no boundary attribute, so there is nothing hydratable.

Differences (not forced to parity): Node adds `connection`, `content-length`, `date`, `keep-alive`;
workerd answers with `content-encoding` and `transfer-encoding`. Log framing differs (`ERROR …` on Node,
`✘ [ERROR] ERROR …` with minified frames on workerd); the same single error appears on both. workerd shows
no `console.log` from the Worker, so the fixture probe writes its server line with `console.error`.

What the browser then shows (both runtimes, no error in the console):

- `constructor` / `service`: the SSR response had an empty outlet, so Angular cleanly re-renders the page
  on the client. The surrogate's template is empty, so the page appears around an **empty
  `<failure-scenario>`**; no island, no browser error.
- `template`: the half-rendered DOM stays visible and inert. No boundary host is found, so nothing is
  hydrated and nothing is reported in the browser.

**HTTP 200 plus an empty shell is the exact current Angular/Analog buffered SSR failure behaviour. It is not a
Strata success response**, and the failed component is not "rendered successfully". A half-rendered
component with HTTP 200 is a worse shape and is recorded as a risk (below).

### Is there a supported seam to turn a render failure into a failed response, or a fallback?

Checked against the exact installed tuple, public APIs only:

- `renderApplication` (`@angular/platform-server`) resolves after `whenStable`; errors thrown while
  rendering go to the application `ErrorHandler`, they do not reject the render. Analog's `render()`
  just `await`s it.
- `BEFORE_APP_SERIALIZED` callbacks that throw or reject are also routed to the same handler
  (`renderInternal`), not rethrown.
- The only public lever left is a **global** `ErrorHandler` that rethrows every Angular error. That
  changes the semantics of every unrelated error in the application, so Strata does not ship it.
- Analog's `experimental.streaming` is an option of another plugin; Strata cannot read it through a public
  seam.

**Server Component render-response recovery: NO SUPPORTED STRATA SEAM.** The measured safe behaviour
above is the contract; no fallback UI and no non-200 status is claimed.

## B. Serialization failure

`/server-component-failure/{instance,nested,nan}`: a cast smuggles a class instance, a nested object or
`NaN` into `[strataClient]`.

- Both runtimes: HTTP 200; the rest of the component renders (`Scenario rendered`, `tail rendered`, the page
  sibling). Exactly one `StrataBoundaryError` reaches the server `ErrorHandler`, naming the prop and the reason
  (`prop "start": an instance of … is not supported.` / `a nested object` / `the non-finite number NaN`).
- The invalid value is never serialized: no `data-strata-props` exists anywhere in the response, and the
  class name, `NaN` and the nested object are not in the HTML.
- **Pinned platform result, not the ideal one:** Angular applies a directive's host attribute bindings in
  order, and the props binding throws third, so the boundary host keeps
  `data-strata-client="failure-island" data-strata-protocol="1"` without props. This is a _partial_
  boundary, never `props=<invalid>`. The browser's preflight finds it through the any-attribute selector,
  refuses it (`data-strata-props is missing`), hydrates nothing, leaves the SSR DOM, and reports one
  `StrataBoundaryError`. There is no duplicate render, no retry loop (still one report after more time) and
  one document request.

## C. Browser preflight failure and sibling-host isolation

Fixture `/server-component-failures`: A, B, C each with three islands. Host B's markup is rewritten
in-flight by Playwright before the browser parses it (no production test API):

| Case                                                                              | Host B                                         | A, C                    | ErrorHandler                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| boundary 2 has `data-strata-protocol="999"` (1 and 3 valid)                       | 0 of 3 hydrated, 0 constructed, same SSR nodes | 3 + 3 hydrated, working | exactly 1 `StrataBoundaryError`, `(boundary 2 of 3 in <failure-host>)`             |
| boundary 2 has invalid JSON (1 and 3 valid)                                       | same                                           | same                    | exactly 1; `data-strata-props is not valid JSON.`; payload text absent from errors |
| **stale assets:** every boundary of B is protocol 999 (server newer than browser) | same                                           | same                    | exactly 1; `(boundary 1 of 3 …)`                                                   |

Also asserted: B's elements are the same objects with the same parent and next sibling; B inert on
click; one click is one effect on A:1 and C:3; one `console.error` (Angular's handler), no `pageerror`, no
unhandled rejection; no retry (the markup was repaired and, 2 s later, B was still inert with nothing
more reported); no reload, one document request, same realm; leaving through a router link destroys the six
live islands once, leaves no view and reports nothing more; re-entering through a new document is a fresh
attempt with one report (not two).

**Automatic stale-client recovery is not implemented.** The affected host stays inert with its SSR DOM, its
siblings hydrate, and nothing reloads, invalidates a service worker or reconciles assets. That belongs to
deployment/version-skew hardening.

## D. Hydration commit failure

An island's constructor (`createComponent`) or an input transform (`setInput`) throws on B:2 after B:1 was
created and attached. Result, Node:

- B:1 constructed once and destroyed once; for `setInput`, B:2 was constructed and destroyed as well;
  B:3 was never created. Every island this commit created is destroyed, so its view is detached:
  `ApplicationRef.viewCount` equals the nine-island baseline minus B's three.
- No `data-strata-hydrated` on B; A and C hydrate (3 + 3) and work (a second click gives 2).
- **DOM identity after rollback:** B's host elements, buttons and outputs are the same objects, in the same
  position (same parent, same next sibling), with the same SSR text. Nothing is replaced with client output.
- The `ErrorHandler` receives exactly one error: the component's own `Error`, **not** relabelled a
  `StrataBoundaryError` (arbitrary component exceptions are not protocol errors). One `console.error`, no
  `pageerror`.
- No retry (2 s later nothing changed, one document request). Teardown afterwards destroys every constructed
  island exactly once, leaves no view and reports nothing new.

`StrataIslandHost` attempts hydration **once per host lifecycle**: no timer, `MutationObserver`, reload or
retry.

## E. Error after successful hydration

An island that hydrated, whose click handler then throws: each click gives exactly one `ErrorHandler`
report (1, then 2). Strata does not roll back, destroy the host, retry or wrap the handler: still nine
hydrated, nothing destroyed, no new island, same `viewCount`. The island's own state does not change, and
its siblings and other hosts keep working. After `data-strata-hydrated` the island is an ordinary Angular
component; the error is Angular's and the application's.

## F. Document navigation, Back and re-entry

Origin `/server-component-failures` (healthy) → plain anchor to `/server-component-failure/constructor` →
Back → the same destination again, on both runtimes:

- The click is a document navigation: a new document request, `navigation.type === "navigate"`, a different
  `performance.timeOrigin`, the origin's window sentinel gone, no `failure-host`, no hydrated marker and no
  island of the old realm.
- The failing document follows the A contract (HTTP 200, empty outlet), with exactly one server
  `ErrorHandler` report.
- **Back:** observed as a new document (`navigation.type === "back_forward"`, `pageshow.persisted === false`),
  not bfcache, in Chromium 1.62.1 headless on both runtimes. The origin is usable: nine islands hydrated,
  each constructed once, zero reports, and one click is one effect. No failed-host state crosses over.
- **Re-entry:** a second request, another realm, one more server report (not an accumulation), no
  browser-side leftovers. Router navigation into a Server Component subtree stays NO-GO and is not touched here
  (the existing negative regression still runs in `pnpm test:server-component-navigation`).

## Streaming decision

`@strata-sc/server-components` is qualified with **buffered SSR only**. Analog's experimental streaming
(`experimental.streaming` of `@analogjs/platform`, `renderStream`) is **unsupported and not qualified**.
Strata defines no failure-after-headers behaviour, so the RELEASE-1.0 criterion is met by the second
alternative ("streaming is explicitly unsupported"). The Strata Vite plugin cannot see another plugin's
options through a stable public seam, so there is no build diagnostic; it is documented, not detected.
Nothing was implemented (no stream chunk protocol, trailer or Suspense-like transport).

## Not done, by decision

No Error Boundary API (`@ErrorBoundary`, `fallbackTemplate`, `catch()`, `retry()`), no fallback UI, no
retry or reload protocol, no new DOM attribute (protocol v1 is unchanged), no new consumer-facing API or
provider, no global `ErrorHandler`.

## Remaining gaps

- Render failures answer HTTP 200 with an empty outlet (construction) or a half-rendered component
  (template). There is no supported Strata seam to change the status or to render an application-level
  fallback. The half-rendered case ships partial markup that is inert but visible.
- A serialization failure leaves a partial boundary host (client and protocol attributes, no props) in the
  HTML. It is safe (the browser refuses it) but not absent.
- The browser reports nothing for a render failure that happened on the server: the signal is the server
  `ErrorHandler`.
- Dev/HMR, Angular Router navigation into a Server Component subtree, streaming, a deployed environment and
  real version-skew recovery are unqualified.
- A custom `ErrorHandler` that throws is not exercised; its behaviour is Angular's and the consumer's.

## Verdicts

| Area                        | Verdict                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server render failure       | **CONDITIONAL GO**: safe and pinned on Node and workerd, no data leak; HTTP 200 and partial output are Angular/Analog's and cannot be improved by a supported Strata seam |
| Serialization failure       | **GO**: invalid values never reach the HTML, one useful error, the browser refuses the partial boundary (the partial host is a recorded platform result)                  |
| Boundary preflight          | **GO**: fail-closed per host, one data-safe `StrataBoundaryError`, SSR DOM kept                                                                                           |
| Hydration commit rollback   | **GO**: islands destroyed, views detached, same DOM nodes restored, one report                                                                                            |
| Sibling-host isolation      | **GO**: A and C hydrate and work while B is inert (preflight and commit), exactly one report                                                                              |
| Document-navigation failure | **GO**: new document, same contract, Back and re-entry are clean lifecycles                                                                                               |
| Streaming                   | **UNSUPPORTED**                                                                                                                                                           |
| Overall failure/recovery    | **CONDITIONAL GO** for buffered SSR + document navigation (condition: the server-render response shape above, and the unqualified items under "Remaining gaps")           |

NO-GO discovered: none new. "Server Component render-response recovery" has no supported Strata seam, which
is recorded as a finding, not a regression.

## Regressions

`pnpm test:server-component-security` (data confidentiality, Node + workerd), `test:server-components`
(protocol v1, recursive composition), `test:server-component-defer`, `test:server-component-server-only`,
`test:server-component-navigation` (including the Router NO-GO regression) and
`test:server-components:cloudflare` stay green with the fixture's new `ErrorHandler` probe in place.
