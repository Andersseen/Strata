# M3/M4 contract stabilization

**Status:** implemented on `stabilize/m3-m4-contract-hardening` ([PR #168](https://github.com/Andersseen/Strata/pull/168));
local verification and hosted results are recorded below. This work adds no
feature, export, package, runtime, protocol or rendering mode. It does **not** qualify production
use, M3, M4, M5 or Strata 1.0.

## Basis

- Starting main: `bf00a944544d1f6533d4b05a1876449ff59b7dd3` (`origin/main` = local `main` on
  2026-11-05; merge of PR #167).
- Published on npm (`latest` = `next`): `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.12.0,
  `@strata-sc/server-components` 0.14.0. `@strata-sc/h3` is private.
- Local environment: macOS (Apple Silicon), Node 22.23.1, pnpm 10.30.1, Playwright 1.62.1 Chromium.
- External consumer tuple (direct pins): Angular 22.2.3, `@angular/build` 22.1.8, Analog 2.7.2,
  nitropack 2.13.4, h3 1.15.11, Vite 8.3.0, TypeScript 6.0.3 and 5.9.2, Wrangler 4.135.0
  (compatibility date 2026-09-21, no `nodejs_compat`). Transitive versions float with the registry
  (fresh `npm install`, no lockfile): `@analogjs/vite-plugin-nitro` 2.9.6, Rolldown 1.2.0 on this run.

Evidence labels: IMPLEMENTED · UNIT · LOCAL NODE · LOCAL WORKERD · PACKED CONSUMER · PUBLISHED
REGISTRY · HOSTED CI · DEPLOYED · REAL APPLICATION. A label is used only for evidence that exists.

## Contract inventory and the gaps found

| Contract                               | Existing evidence before this work                                     | Gap found                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Controller metadata and inheritance    | Own-metadata only; undecorated/decorated subclasses unit-tested        | Overrides and factory dispatch unpinned                                                                    |
| Registration preflight and commit      | Whole-batch preflight, shapes, repeated calls, `router.add()` failure  | None: the documented non-transactional limit is tested and matches the bookkeeping (verified, not changed) |
| Request parsing and validated bodies   | Unit, internal fixture, packed consumer                                | **Defect**: a 413 desynchronised the Node keep-alive connection (below)                                    |
| Guards, interceptors, factory, cleanup | Exhaustive unit tests; internal fixture DI matrix                      | Installed-package composition matrix absent; cleanup-failure precedence not proven through Nitro           |
| Streaming                              | Unit, internal fixture, packed consumer (Node, workerd)                | None new; upstream NO-GOs unchanged                                                                        |
| External Angular DI                    | Packed Node profile: auth, overlap, streaming, close hook              | Validation, two-interceptor order, failure matrix, confidentiality, workerd                                |
| Boundary serialization                 | Shared `checkBoundaryProps` for writer and preflight; unit and browser | Writer and reader agree by construction; per-host budgets are browser-only (documented, fail closed)       |
| Hydration failure and rollback         | Workspace fixture (`test:server-component-failures`)                   | Commit-phase rollback never exercised through the installed tarball                                        |
| SSR integrity classification           | Classifier used by every SSR suite                                     | No tests of the classifier itself; a false negative for escaped canaries                                   |
| Public API                             | Declarations compiled strictly by consumers                            | No inventory; declaration/runtime parity unchecked                                                         |
| CI                                     | Five parallel jobs and `Verify`                                        | Extended rejected with zero jobs; `test:analog` and `format:check` in no workflow                          |
| Release                                | State classifier (PR #163), exact-CI `workflow_run` gate               | Two hosted failures from dist-tag read-after-write lag                                                     |

## Reproducible defects and fixes

### D1 — keep-alive desynchronisation after an oversized validated body (production, fixed)

Found by the extended packed DI consumer: in a 24-request mix, one valid request answered a bare
`400 Bad Request` with an empty body, which Strata never produces. Reduced to one raw keep-alive
connection on the consumer's real Nitro `node-server`: an authorized POST whose JSON body exceeds the
1 MiB validated limit, then a GET on the same socket.

| Server                                                     | First response | Next request on the same connection |
| ---------------------------------------------------------- | -------------- | ----------------------------------- |
| Nitro node-server, published reader (DI route)             | 413            | **400** (Node parser error), 4 of 4 |
| Nitro node-server, published reader (non-DI fixture route) | 413            | **400**                             |
| Plain `node:http` + H3 v1, same installed packages         | 413            | 200                                 |
| Nitro node-server, fixed reader (3 runs + non-DI route)    | 413            | 200                                 |

Cause: on Node, the bounded reader left a `for await` loop over the `IncomingMessage` at the limit.
Node's iterator then destroys the message (detached from its socket). Instrumentation showed the
whole body had been read in both servers, but under Nitro the parser had not yet completed the
message (`complete: false`) when it was destroyed; the connection's parser fell out of step and
parsed the next request as garbage. A plain server usually wins that race, which is why the unit
suite and the internal fixture never saw it. Behind a proxy that reuses upstream connections, that
next request may belong to another client.

Fix (`packages/analog/src/register-controllers.ts`, patch Changeset): for a real Node request the
reader stops collecting at the limit and lets the rest flow to nowhere (`resume()`), as Node does for
any unread body. The 413 body, `onRequestSettled` outcome and the memory bound are unchanged;
workerd (body attached by the runtime) and other adapters keep the previous path.

Evidence: IMPLEMENTED; UNIT (`body-limit-connection.test.ts`: a deterministic regression — the
still-incomplete message is not destroyed when the 413 is sent — fails on the old reader, plus
JSON/form/415 connection checks); LOCAL NODE (raw-socket A/B above); PACKED CONSUMER (the
keep-alive check and the 24-request matrix pass). Not hosted-CI or deployed yet. Migration: none.

### D2 — dist-tag verification failed on registry read-after-write lag (release tooling, fixed)

Release runs [41526028881](https://github.com/Andersseen/Strata/actions/runs/41526028881) and
[41615685717](https://github.com/Andersseen/Strata/actions/runs/41615685717) failed in
`sync-dist-tags`: `next 0.2.0 → 0.14.0` succeeded, the single immediate re-read returned 0.2.0, the
step failed. npm reports `next: 0.14.0` today and later runs found the tags compliant. Verification
now re-reads with `--prefer-online` up to six times (2 s doubling to 16 s) and still fails closed with
the last tags. IMPLEMENTED; UNIT. No tag was changed by this work.

### D3 — SSR integrity classifier missed HTML-escaped structured canaries (verifier, fixed)

`assessSsrDocument` searched forbidden values only as raw substrings. A structured value crossing in
`data-strata-props` is JSON whose quotes are `&quot;`, so a leak of such a value would not have been
classified. It now also searches the document with character references decoded. UNIT. No package
change.

### D4 — Extended workflow rejected before any job (CI, fixed)

`extended.yml` set `STRATA_DIAGNOSTICS_DIR: ${{ runner.temp }}/…` in the adversarial job's
job-level `env`, where the `runner` context is unavailable. actionlint 1.7.12 reports exactly this
one error across the seven workflows. GitHub rejected the file, so every Extended run from PR #167 on
— including the push to main, [41882561874](https://github.com/Andersseen/Strata/actions/runs/41882561874)
— failed with zero jobs, and the weekly schedule could not run any suite. The directory is now set in
a step through `GITHUB_ENV`. The last scheduled run that did start
([41440983466](https://github.com/Andersseen/Strata/actions/runs/41440983466), 2026-11-02) failed in
`performance` on the dependency-tree mismatch PR #164 fixed; that fix has therefore never run hosted
in Extended.

### D5 — the published Cloudflare gate had not built since 2026-10-21 (CI, fixed)

The repaired Extended run [42001301096](https://github.com/Andersseen/Strata/actions/runs/42001301096)
started all seven jobs; six passed. The seventh, `test:server-components:deployed-cloudflare` (also the
basis of the manual real-deployment workflow), failed: it copied the shared fixture without the
published-artifact adaptation `registry-consumer.ts` applies, and since the fixture gained package islands
(2026-10-21) its Server Components import a private test library no registry gate installs. Its only green
run since then (41440983466) printed NOT APPLICABLE because 0.14.0 was not yet on npm, so it built nothing.
The adaptation is now one helper used by both registry gates, and a NOT APPLICABLE run emits a warning
annotation. Locally the gate now passes for published 0.14.0 (Local build GO, workerd verifier, 0 failing).

## Tests added or strengthened

| Area                      | Change                                                                                                                                                                                          | Evidence                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Inheritance               | Re-decorated override, undecorated override, factory returning a subclass (registered method runs: non-virtual dispatch, pinned as current behavior)                                            | UNIT                                             |
| Body limits               | Real `node:http` + H3 v1 keep-alive regression (above)                                                                                                                                          | UNIT                                             |
| Packed DI composition     | 33 new checks (90 total): exact lifecycle order per path, Standard Schema, JSON 400/413/415, HTTP error vs cleanup-failure precedence, exactly-once cleanup, 24 concurrent requests, keep-alive | PACKED CONSUMER, LOCAL NODE                      |
| Packed DI confidentiality | Server markers, tokens and credentials in the server output (positive control) and in no browser file or hidden source map; no server/platform-server/Nitro/Strata server source in maps        | PACKED CONSUMER (Node and Pages)                 |
| Packed DI on workerd      | Angular JIT path fails safely; denials still 401 before any factory; every cleanup runs; supported routes keep serving                                                                          | LOCAL WORKERD (NO-GO, characterized)             |
| Commit rollback           | `/pair`: host 2 fails inside `setInput` on its 4th island after three were created; rollback with node identity; one `ErrorHandler` report; sibling host commits and stays interactive          | PACKED CONSUMER, LOCAL NODE, LOCAL WORKERD       |
| SSR classifier            | 11 negative/positive controls                                                                                                                                                                   | UNIT                                             |
| Public API inventory      | Installed exports targets, declaration = runtime value exports, reviewed baseline                                                                                                               | PACKED CONSUMER; PUBLISHED REGISTRY via Extended |
| Release                   | Bounded dist-tag visibility                                                                                                                                                                     | UNIT                                             |
| CI                        | actionlint and `format:check` in `static`; `test:analog` in `runtime`; published full-stack tuple in Extended `registry`                                                                        | HOSTED CI: see PR                                |

Existing tests reused, not duplicated: the registration contract (including `router.add()` failure),
cleanup precedence, interceptor misuse and streaming unit suites; the internal Analog DI matrix; the
workspace failure suite; the packed 129-boundary refusal; the deployment-skew `/pair` refusal.

## Lifecycle order as implemented

Recorded by consumer code through the installed packages and closed by the settlement observation:

```text
success      guard → outer:before → inner:before → factory → construct → handler
             → inner:after → outer:after → cleanup:injector → cleanup:inner → cleanup:outer
             → cleanup:guard → observed
denial       guard → cleanup:guard → observed                       (401/403, no interceptor)
factory      … inner:before → factory → inner:error → outer:error → cleanup:inner → … → observed
provider     … factory → inner:error → outer:error → cleanup:injector → …   (no constructor body)
handler/400  … construct → handler → inner:error → outer:error → cleanup:injector → … → observed
```

Cleanups run last-registered-first, each exactly once. A `StrataAnalogHttpError` maps to its safe
status only when every cleanup succeeds; any cleanup failure makes the route an unhandled 500
(`cleanup-failed`, `phase: cleanup`, `status: undefined`) and the remaining cleanups still run.

## Cross-runtime differences

- Node and dev share the corrected Node reader; workerd receives an attached body and never had D1.
- Consumer-owned Angular DI: Node GO through installed packages; local workerd NO-GO (Angular JIT
  `EvalError: Code generation from strings disallowed`), now proven to fail safely. The eager
  `await createApplication()` in the consumer plugin does not break Worker start-up: the failure is
  at request time, compiling the request-scoped providers.
- Active-request shutdown: **NOT QUALIFIED**. Nitro exposes no public drain seam; the consumer's
  close hook runs once on stop, which is all that is proven.

## Public API compatibility decisions

The inventory (`tools/package-consumer/public-api.json`) records 11 core, 35 analog and 33
server-components names across six subpaths, with declaration/runtime parity on all of them. No
export was added or removed. Negative controls against an installed consumer each fail with the named
difference: a baseline missing `streamResponse`, an undeclared runtime export appended to the installed core
bundle, and a declared export renamed at runtime. `StrataIslandHost` and `provideClientReferences` are public because
generated surrogates import them: a generated-code contract, not an application API to widen.
`./server-only` is intentionally empty. The runtime bundles use only public Angular APIs; the Vite
plugin depends on `@angular/compiler` template-AST exports (RISKS R21).

SemVer: `@strata-sc/analog` **patch** (D1 is a defect fix with no API or documented-behavior
change). Everything else is tests, tooling, CI and documentation.

## Server Components: what stayed explicit

- Unexpected render failures can still answer HTTP 200 with an empty or partial shell. No supported
  public Angular/Analog seam to change the status exists on this tuple (unchanged finding of the
  SSR-response report); the classifier controls now make sure no qualification counts that as a pass.
- Writer and browser preflight share one validator; protocol versions and the value set are
  unchanged. Per-host budgets (128 boundaries, 1 MiB) remain browser-only and fail closed.
- Document navigation is the supported strategy; Router subtree hydration is not added.
- A module that does not assert `server-only` is not protected by the firewall; no crawler is added.

## Unresolved upstream limitations (unchanged)

H3 v2 strict declarations (crossws); Angular JIT on workerd; no client-disconnect signal through the
pinned Nitro adapters; buffered streaming on Cloudflare Pages; no shared Analog SSR/controller
injector; no Router subtree hydration.

## Next release blockers (evidence-based)

1. Hosted CI and one Extended run of the repaired workflow on this change; then a release of the
   analog patch and a published-registry rerun.
2. Issue #117: hosted observations of cancelled, pending and stale-main Release transitions.
3. A supported error-response mechanism (or an accepted documented contract) for unexpected
   Server Component render failures.
4. Deployed qualification of the composed controller + DI + Server Components path; Node server
   deployment.
5. Real-application adoption (ForgeCMS or equivalent) with migration and rollback.

## Hosted results

- PR CI [42001271320](https://github.com/Andersseen/Strata/actions/runs/42001271320) on `a24af18`:
  `static` (with actionlint and `format:check`), `graph`, `runtime` (with `test:analog`), `consumers`, `apps`
  and the aggregate **Verify passed**; the website deployment was skipped as designed for a pull request.
  Entwine documentation and the registry-artifact verification also passed. HOSTED CI.
- Extended [42001301096](https://github.com/Andersseen/Strata/actions/runs/42001301096) (`workflow_dispatch`,
  `suite=all`, on `a24af18`): the workflow **started all seven jobs** (it could not start since PR #167).
  Passed: performance (first hosted pass of the PR #164 repair), registry-full-stack (published core 0.2.2,
  analog 0.12.0, server-components 0.14.0), registry upgrade/rollback, types (expected upstream-blocked
  verdict), integrity, adversarial (three source-mutated consumers). Failed: the published Cloudflare gate (D5),
  fixed afterwards; its hosted rerun is recorded on the pull request.
