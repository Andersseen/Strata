# Server Component data confidentiality

Evidence report. Recorded 2026-10-07 on branch `feat/server-component-data-confidentiality`,
baseline `61d09a1` (`main`, merge of PR #46, after PR #49). Written by hand;
`pnpm test:server-component-security` reproduces every observation below (production builds, Nitro
`node-server`, Wrangler's local Pages runtime, Chromium). No runtime production code changed.

**Question.** Does a value that stays server-owned cross into browser-visible output merely
because a Strata Server Component reads or uses it? Graph isolation (PR #49) keeps a _module_ out of
the browser graph; a module that never leaves the server can still leak a _value_ through HTML,
hydration state, boundary props, error responses, source maps or public assets.

**Property under test.**

```text
SERVER-OWNED DATA                          [strataClient] DATA
does not cross implicitly.                 is explicitly browser-public.
```

Strata protects implicit crossings. It cannot decide that a primitive string the developer passes
through `[strataClient]` is a business secret, and this report does not claim it can.

## Verdicts

Each area is judged on its own. `GO` = the property held on every measured surface; `CONDITIONAL GO`
= held, with a stated limit that is not closed; `NO-GO` = a surface leaked; `NOT QUALIFIED` = not
measured because the architecture offers nothing to measure.

| Area                                      | Verdict                                                                       | Scope and conditions                                                                                                                                                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module confidentiality                    | **CONDITIONAL GO**                                                            | Production builds: PR #49's firewall holds on the current tuple, and the new DATA modules fail the build with a diagnostic that prints no source. Dev server/HMR is not qualified.                                                                                  |
| SSR HTML confidentiality                  | **GO**                                                                        | Raw response body, comments, inline scripts, `ng-state`, `ngh`, `data-strata-*`, headers; Node and local workerd. Synthetic canary, one fixture route, no deployed environment.                                                                                     |
| Boundary payload confidentiality          | **GO**                                                                        | Protocol v1 payload parsed and checked semantically (exact keys, value set, limits); unsupported objects rejected before serialization with a diagnostic that prints no contents. A secret passed as an explicit string is public by definition (unenforceable).    |
| Browser artifact confidentiality          | **GO**                                                                        | Every file of `dist/client` and `dist/analog/public` (86 files: 2 `.html`, 42 `.js`, 42 `.map`), all browser source maps, hydrated DOM and text before/after interaction, public network responses; Node and workerd. Positive controls on both sides.              |
| Production error-response confidentiality | **CONDITIONAL GO**                                                            | Plain `Error`, `Error.cause`, `AggregateError`: public response, browser console, page errors and rendered document are clean on Node and workerd. Condition: Angular answers HTTP 200 with an empty shell, and the server log (operator surface) keeps the secret. |
| Cross-request evidence                    | **NOT QUALIFIED** (Strata context) / **CONDITIONAL GO** (Angular route param) | Strata has no request context for Server Components. Overlapping requests were qualified only through an Angular route parameter injected by the routed page.                                                                                                       |
| **Overall**                               | **CONDITIONAL GO**                                                            | Open: authorization, tenant/cache isolation, request context, log redaction, dev server, real deployment.                                                                                                                                                           |

## Resolved framework tuple

Versions read from `node_modules` by the gate, not from `package.json` ranges. No dependency was
changed by this slice (`pnpm install --frozen-lockfile` only brought the installation up to the
lockfile that PRs #46 and #48 had already merged).

| Package                                          | Installed |
| ------------------------------------------------ | --------- |
| Node                                             | 22.23.0   |
| `@angular/core`                                  | 22.1.7    |
| `@angular/common`                                | 22.1.7    |
| `@angular/compiler`                              | 22.1.7    |
| `@angular/platform-browser`                      | 22.2.1    |
| `@angular/platform-server`                       | 22.2.1    |
| `@angular/router`                                | 22.1.7    |
| `@analogjs/platform`                             | 2.7.2     |
| `@analogjs/vite-plugin-angular`                  | 2.7.2     |
| `nitropack` (resolved from `@analogjs/platform`) | 2.13.4    |
| `vite` (fixture)                                 | 8.3.0     |
| `typescript` (fixture)                           | 6.0.3     |
| `playwright` (Chromium)                          | 1.62.1    |

The tuple is mixed: `platform-browser` and `platform-server` are 22.2.1 while `core`, `common`,
`compiler` and `router` are 22.1.7 (the platform packages were bumped on their own by Dependabot).
All earlier Server Component gates were rerun on this tuple (see "Existing gates" below); none
changed result.

## Fixture

```text
apps/analog-fixture/src/app/
  server-component-security/
    security-secret.ts                      server-only; DATA canary; digest()
    security-repository.ts                  server-only; @Injectable; holds the credential as an own property
    security-probe-island.component.ts      SecurityProbeIsland (<security-probe>), the client island
    security.server-component.ts            SecurityServerComponent (<security-surface>)
    security-failure.server-component.ts    test-only: repository throws a secret-bearing error
    security-crossing.server-component.ts   test-only: a cast smuggles an unsupported value into [strataClient]
    security-request.server-component.ts    test-only: request-varying PUBLIC value (route parameter)
    security-scenario.ts                    plain Angular InjectionToken fed from a route parameter
  pages/
    server-component-security.page.ts                      /server-component-security
    server-component-security-failure.[mode].page.ts       /server-component-security-failure/{plain|cause|aggregate|none}
    server-component-security-crossing.[mode].page.ts      /server-component-security-crossing/{repository|nested}
    server-component-security-request.[id].page.ts         /server-component-security-request/{a|b}
```

Two synthetic canaries, neither a real credential, neither the module canary of PR #49:

```text
DATA_SECRET_CANARY      STRATA_DATA_SECRET_CANARY_8E41B7D2A6F9      read by a server-only repository
PUBLIC_CONTROL_CANARY   STRATA_PUBLIC_CONTROL_CANARY_3C95E0A7D184   passed on purpose through [strataClient]
```

The Server Component renders `Internal verification: ready` and hands the island
`{ label, control: PUBLIC_CONTROL_CANARY, enabled: true }`.

### The secret is consumed, not merely present

`SecurityRepository.verifyInternalConfiguration()` compares an FNV-1a digest of the credential with
an expected digest, so the rendered verdict depends on the credential's value and only a boolean
leaves the module. Control: the gate edits the credential in the built server output (one file
patched), restarts the server and the same route renders `Internal verification: not ready`. The
route's error variants additionally throw the credential from the same repository, which the server
log shows.

## Scanner

[`tools/server-components/lib/leak-scan.ts`](../../tools/server-components/lib/leak-scan.ts) is the
reusable helper (no second graph scanner: graph scans delegate to `graphFilesWith` and the source
map helpers of `lib/server-only.ts` from PR #49). A canary is matched raw and as a truncated family
prefix, unique suffix, lower-case, reversed, base64 at three alignments, hex, percent-encoded, HTML
decimal/hex entities and JS `\u` escapes. Controls that keep it honest:

- **Self-test.** Each claimed encoding, embedded in unrelated text, is found; the sibling PUBLIC
  canary and clean HTML are not reported as DATA.
- **Plugin-off build.** With `STRATA_SERVER_COMPONENTS=off` the DATA canary and both secret modules
  reach `dist/client` and its source maps, so the browser-artifact scan can see them.
- **Server graph.** The canary is present in `dist/ssr`, `dist/analog/server` and the reachable
  Worker graph.
- **PUBLIC control.** Found in the SSR HTML, the parsed payload, the island's rendered input, the
  hydrated `outerHTML`/`innerText` before and after a click, and the document response.
- **Operator log.** The error-path scans, run over the server log, flag the canary, stack frames and
  absolute paths, so the same probes are known to fire on real leaks.
- **Error-path control.** `/server-component-security-failure/none` renders its component; the
  three failing modes do not, so "nothing leaked" is not an artifact of a missing route.

## Observations

### Node (Nitro `node-server`, production, hidden source maps)

| Surface                                                                                     | DATA canary | PUBLIC control  |
| ------------------------------------------------------------------------------------------- | ----------- | --------------- |
| `dist/ssr`, `dist/analog/server`, SSR source maps                                           | ✓ present   | n/a             |
| `dist/client`, `dist/analog/public` (86 files), all browser source maps                     | ✗ 0         | n/a             |
| Secret modules in any browser source map; their source (`readInternalCredential`, …)        | ✗           | n/a             |
| Raw `GET /server-component-security` body (200, `text/html`)                                | ✗           | ✓ (props, text) |
| HTML comments (2), inline scripts (3), `ng-state`, `ngh` (4), `data-strata-*` (3)           | ✗           | props only      |
| All response headers (no `Set-Cookie`)                                                      | ✗           | n/a             |
| Protocol v1 payload: keys exactly `label`, `control`, `enabled`; flat; ≤ 64 props; ≤ 64 KiB | ✗           | ✓ `control`     |
| Hydrated `outerHTML` / `body.innerText`, before and after a click (`Pings: 1`)              | ✗           | ✓               |
| Cookies, `localStorage`, `sessionStorage`                                                   | ✗           | n/a             |
| Public network: document + 9 scripts, no `fetch`/XHR                                        | ✗           | ✓ document      |
| Console: no errors, warnings or page errors                                                 | n/a         | n/a             |

### Unsupported values crossing `[strataClient]`

A cast puts the repository instance (its own property holds the canary) or a nested object holding
the canary into `[strataClient]`.

```text
[strata] Cannot serialize client boundary <security-probe>: prop "repository": an instance of SecurityRepository is not supported.
[strata] Cannot serialize client boundary <security-probe>: prop "configuration": a nested object is not supported.
```

`StrataBoundaryError` is thrown inside Angular's host binding, before `JSON.stringify`. The
boundary host in the HTML has `data-strata-protocol="1"` and no `data-strata-props`; the response
and the log of the rejection carry no canary and no `{`, JSON or field name (workerd's bundle prints
the minified class name instead; still a type description). The unit tests
(`packages/server-components/src/runtime/boundary-protocol.test.ts`) add a class instance, nested
and null-prototype objects, a function and an `Error` whose contents hold a canary, an array, `Map`,
`Promise`, and assert that no `toString`/`toJSON`/`valueOf` runs, `JSON.stringify` is never called,
and neither the message nor the stack contains the value. The browser-side diagnostic is checked the
same way. A string containing the canary passes by design (documented in a test).

### Secret-bearing production errors

The server-only repository throws, in a routed page, from the Server Component's constructor:

```ts
throw new Error(`Synthetic server failure ${credential}`);
throw new Error("public wrapper", { cause: new Error(credential) });
throw new AggregateError([new Error(credential)], "Synthetic aggregate failure");
```

| Runtime            | Status | `content-type` | Headers                                                    | Body                                                      |
| ------------------ | ------ | -------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Node (production)  | 200    | `text/html`    | connection, content-length, content-type, date, keep-alive | 890 chars: the application shell, empty `<router-outlet>` |
| workerd (Wrangler) | 200    | `text/html`    | content-encoding, content-type, transfer-encoding          | 890 chars: the same shell                                 |

No status was forced: Angular reports the template error to its `ErrorHandler`, completes the render
without the failing component and Analog serves the result. For all three shapes, on both runtimes:
the DATA canary (any encoding) is absent from the headers and body; no stack frame, `file://` URL,
source location, `node_modules` or chunk path, absolute path (checkout or home), secret-module name
or fragment of its source appears in either; the browser shows 0 console messages and 0 page errors
and a 1,497-char document with no canary or internals; the public network (document + 9 scripts)
is clean. `Error.cause` and `AggregateError` are handled by the pinned runtime and, in the server
log, are printed in full (`[cause]`, `[errors]`).

**Server log (operator surface, recorded apart from the public response).** On both runtimes the
log of the failing request carries the thrown message, the canary, the cause/aggregate members and
stack frames with absolute paths: an operator surface. Strata adds no exception filter and does not
redact it; the report does not call that a public leak.

### Build diagnostics

A temporary island importing the DATA modules fails the production build with PR #49's diagnostic:

```text
[strata] Server-only module entered the browser graph: src/app/server-component-security/security-secret.ts
Imported from: src/app/security-illegal/illegal-island.component.ts
Reason: the module declares `import "@strata-sc/server-components/server-only";`.
```

Direct import, `?raw` import (the `?raw` suffix is kept in the module path) and an import of the
repository each exit non-zero with module, importer and reason, and the whole combined stdout/stderr
carries neither the canary nor a line of the modules' source. The temporary files are always
removed.

### workerd (`BUILD_PRESET=cloudflare-pages`, Wrangler Pages, no `nodejs_compat`)

Same surfaces, same results: the canary is in the reachable Worker graph
(`_worker.js/chunks/_/security-repository-*.mjs`) and in no public asset or public source map; the
raw HTML, headers (`content-encoding: gzip`, `transfer-encoding: chunked`), payload, hydrated DOM and
network are clean with the PUBLIC control present; the Worker's secret-bearing chunk, requested
under `/_worker.js/…`, does not serve the canary; the three secret-bearing errors answer HTTP 200
with the same empty shell; the Wrangler/workerd log carries the original error (operator surface).

## Cross-request evidence

```text
Cross-request Server Component data isolation (Strata):  NOT QUALIFIED
```

Strata gives a Server Component no request context: there is no `StrataRequest`, `useRequest()` or
request-scoped injector, and none was invented. Angular itself gives a _routed page_ a request-varying
input, the route parameter. The gate uses it only as an existing Angular mechanism: the page
provides a plain `InjectionToken` from `ActivatedRoute`, the Server Component injects it and renders
`PUBLIC_A` or `PUBLIC_B` after an asynchronous hold (`PendingTasks`, 250 ms) so renders interleave.
24 simultaneous requests (12 for each value): every response carried only its own value, none the
other's, and the server-only verification was `ready` in all of them, on Node (284 ms for the
batch, against ≥ 6,000 ms serially) and on workerd (290 ms). This qualifies Angular's route-param
DI under overlap on this tuple; it does not qualify any Strata-owned request data, tenant data or
cache.

### Shared state is not request isolation

Angular SSR and Nitro may evaluate a shared module separately (PR #38; package README, Experimental
restrictions). Relay's `processSingleton` is a domain-state workaround for that. It is **not**
request isolation, tenant isolation or a security boundary, and must not be used as one.

### No global registry

The runtime keeps no global payload, process-wide boundary store or secret cache. Checked three
ways: a TypeScript AST scan of `packages/server-components/src/runtime` finds no reference to
`globalThis`, `window`, `self`, `global`, `process`, browser storage or `Symbol.for` and no
module-scope mutable collection (`FORBIDDEN_KEYS`, an immutable lookup table, is the only one); the
HTML has no `__STRATA_DATA__` or `window.__STRATA*` assignment; the hydrated browser's
strata-named `window` keys are only the fixture's own probes (`src/probes`). Payload ownership
stays on the SSR host element, as protocol v1 defines.

## Existing gates on this tuple

Run on the resolved tuple above: `pnpm build`, `lint`, `typecheck`, `test`, `format:check`,
`test:server-components`, `test:server-component-navigation`, `test:server-component-defer`,
`test:server-component-server-only`, `test:server-components:cloudflare`,
`test:www:server-components`, `test:relay:server-components`, `test:analog`,
`test:package-consumer`, `www:build`, `www:build:cloudflare` and the new
`test:server-component-security`. See the pull request for the run results. The historical
`@strata-sc/h3` strict type-closure blocker (`pnpm test:consumer`, AC2) is separate and unchanged.

## What this does not show

- **Authorization**, tenant isolation and cache isolation: nothing here exercises a second user, a
  shared cache or a CDN.
- **A Strata request context.** Cross-request Server Component data is NOT QUALIFIED.
- **Log and reporter redaction.** The operator log keeps the secret; Strata adds no filter.
- **Error semantics.** A failed Server Component render answers HTTP 200 with an empty shell on both
  runtimes. That is Angular's and Analog's behaviour, recorded and not redesigned here; it is a
  correctness question, not a confidentiality one.
- **Dev server/HMR**, streaming, `HEAD`/non-GET, a real deployed Cloudflare project, other Angular,
  Analog or Nitro versions.
- **Explicit strings.** Anything passed through `[strataClient]` is public.
- **Extensions not produced by this build.** The browser output has `.html`, `.js` and `.map` only;
  `.mjs`, `.css`, `.json` and `.txt` are scanned wherever they appear (every file is read) but this
  build emitted none.

## Recommended next step

One step, not started: **qualify a read-only request context seam for Server Components**
(a supported way for a Server Component to read per-request input, with overlapping-request
isolation measured on Node and workerd). Authorization, tenant isolation and cache isolation all
depend on it, and today the cross-request row above can only say NOT QUALIFIED.
