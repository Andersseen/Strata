# Server Components production SSR integrity (0.7.0)

Date: 2026-10-23
Baseline: `main` at `a54948b614368d8d0246f11fca34e72ea02838aa` (`@strata-sc/server-components` 0.6.0, `@strata-sc/analog` 0.6.0)
Branch: `feat/server-components-ssr-integrity-v07`

## Question

Why does a production Server Component SSR sometimes return HTTP 200 with an empty island and
`JIT compiler unavailable` in the log, and can Strata prevent it, or at least make it a deterministic failure,
through supported mechanisms only (no Angular/Analog private APIs, no retries, no fake HTTP 500)?

## Pinned tuple

| Runtime/package                         | Version      |
| --------------------------------------- | ------------ |
| Node                                    | 22.23.1      |
| Angular core                            | 22.1.7       |
| Angular platform-browser                | 22.2.3       |
| Angular platform-server                 | 22.2.2       |
| Analog platform / vite-plugin-angular   | 2.7.2        |
| Vite                                    | 8.3.0        |
| TypeScript                              | 6.0.3        |
| Playwright                              | 1.62.1       |
| Hosted runner of the failures (Actions) | ubuntu-24.04 |

## Original evidence

| Run                                                                          | Branch                             | Signature                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [39740436592](https://github.com/Andersseen/Strata/actions/runs/39740436592) | `changeset-release/main` (PR #112) | Packed consumer, **Node production**: `GET /product` is 200 `text/html` but the document has no server content, no boundary, no `add-to-cart` output. The server log holds `ERROR Error: JIT compiler unavailable` with the stack `getCompilerFacade` ← `ProductPage2.get` ← `getComponentDef` ← `ViewContainerRef.createComponent`. The build had exited 0. |
| [39747381460](https://github.com/Andersseen/Strata/actions/runs/39747381460) | `main`                             | Same packed consumer: Node passed, **local workerd** `GET /product` failed with the same empty document (the log excerpt available shows only the assertion failures).                                                                                                                                                                                       |

The stack is the decisive clue: the failing class is the consumer's own page, `ProductPage`, and the failing access
is its `ɵcmp` **getter**. Angular installs that lazy getter only when a class is JIT-compiled from a still-applied
`@Component` decorator. An AOT-compiled class has a static `ɵcmp` property (the passing build's output shows
`_ProductPage.ɵcmp = ɵɵdefineComponent({...})`). So `ProductPage` reached the server **uncompiled**. No Strata
surrogate, protocol or runtime code was involved. The two runs were never captured with their build output (PR #115
added server logs and fixture output afterwards), and no later run reproduced it (CI runs 39783343860 through
39793399872 pass; run 39781556585 fails in the unrelated navigation Ctrl/Cmd-click check).

## Hypotheses

| Hypothesis                                                                                     | Result                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strata surrogate/protocol/runtime produces the failure                                         | **Rejected by the stack**: the failing class is app-owned and never touched by a surrogate.                                                                                                                                                                 |
| Angular linker skipped for a partial library (`@strata-test/angular-widgets`, runtime package) | **Not the observed failure** (the failing class is the page), but a real class of failure; now covered by the gate (below).                                                                                                                                 |
| Vite SSR externalization loads a partial package unlinked                                      | Not observed. Strata already forces `ssr.noExternal` for the runtime and registered packages; Nitro copies other traced packages (`@angular/common`, `@analogjs/content`) still partial-compiled, but nothing evaluates them (see "Remaining uncertainty"). |
| Stale caches / concurrent builds of one consumer                                               | Not reproduced: the harness removes `dist`, `.nitro`, `.angular`, `src/generated` before each build.                                                                                                                                                        |
| Generated files unavailable before compilation                                                 | Not the cause: the page is not generated; `config()` writes the surrogates before Analog reads its tsconfig.                                                                                                                                                |
| Duplicate Angular runtime identities                                                           | Not consistent with the signature (the failing getter is the JIT-installed one, not a second runtime).                                                                                                                                                      |
| **Analog compiles once and shares the result between concurrently built environments**         | **Confirmed mechanism** (reproduced, below).                                                                                                                                                                                                                |

## Mechanism (confirmed by reading the installed sources and by reproduction)

1. `@analogjs/vite-plugin-nitro` 2.7.2 builds `client` and `ssr` with
   `await Promise.all([builder.build(client), builder.build(ssr)])` and `builder.sharedPlugins: true`. There is
   **one** `@analogjs/vite-plugin-angular` instance for both environments.
2. That instance keeps one `outputFiles` map and, in non-watch builds, its `buildEnd` hook calls
   `releaseCompilation()`, which clears `outputFiles`, `outputFile` and the compilation, whichever environment
   ended first.
3. Its `transform` looks the file up with `fileEmitter(id)`. When nothing is found it only _warns_ (and only for
   some shapes of code) and returns, leaving the TypeScript to Vite's esbuild/oxc transform, which lowers the
   decorators to `__decorate([Component({...})], X)`: **JIT-form output**, with a successful build.
4. If the `client` environment reaches `buildEnd` while `ssr` is still transforming a module, that module (and
   every later one) is emitted uncompiled. How far apart the two environments are is a matter of scheduling and
   machine load, hence an intermittent failure that passes repeatedly on a fast workstation and appears on a
   loaded hosted runner.
5. At runtime Node SSR has no `@angular/compiler` loaded, `getCompilerFacade` throws `JIT compiler unavailable`
   inside `createComponent`, Angular reports it once, and Analog returns the shell as HTTP 200
   ([SSR response report](server-component-ssr-response.md): no supported status bridge exists).

### Reproduction

A fault-injecting plugin in the consumer (`enforce: "pre"`) held the `ssr` transform of `product.page.ts` until the
`client` environment's `buildEnd` had run, then 1.5 s more. Before the fix, with the otherwise unchanged packed
plugin:

```text
[race] ssr transform waiting
[race] client buildEnd
[race] ssr transform resumed
```

`vite build` exited 0 **with no warning**, and `dist/ssr/assets/product.page-*.js` contained
`ProductPage = __decorate([Component({`, plus the same for `AddToCartComponent`, `LegacyCounterComponent`,
`ProductDetailsServerComponent` and `ProductRepository`: the failing signature.

Natural frequency: **0 of 18** un-injected clean builds on the development machine (macOS, Node 22.23.1). The
failure was not reproduced naturally anywhere; the two hosted occurrences are attributed by signature match, not
proven.

## Implementation

`packages/server-components/src/vite/` (no public option or API added):

1. **Environment barrier** (`plugin.ts`). In a build, each environment registers at `buildStart`. At `buildEnd` it
   leaves, and waits until every environment of the build has left; `closeBundle` also leaves, so a build that
   fails before `buildEnd` cannot strand a waiter. The plugin is `enforce: "pre"`, so its `buildEnd` runs before
   Analog's `releaseCompilation()`: the shared compilation is released only after all environments finished
   transforming. Only public Rollup hooks.
2. **Production compilation gate** (`aot-integrity.ts`, hooked as `transform: { order: "post" }`). After every
   other transform, in a `vite build`, using the TypeScript parser that the plugin already depends on:
   - a **source-owned** module (inside the app root, not `node_modules`) fails the build when a call that resolves
     to an `@angular/core` import of `Component`, `Directive`, `Pipe`, `Injectable` or `NgModule` (aliases and
     namespace imports included) is still applied as decorator syntax or inside the array given to `__decorate` /
     `__esDecorate`;
   - **any** module fails the build when it still calls a partial declaration
     (`ɵɵngDeclare*({ minVersion, … })`, the stable metadata contract between libraries and the linker; Angular's
     own _definitions_ of those functions are not calls and do not match).
     The error names the display path (app-relative, or from the last `node_modules/`), the environment and the class
     names, states the runtime consequence and the likely cause, and carries no source text or absolute path. It is a
     structural invariant of the transformed module, not a match on a minified symbol or stack.

Why a post-transform hook and not an `ngc`/`buildEnd` check: Vite's transform pipeline is where the Angular plugin's
output (or its absence) becomes observable per module and per environment; the Angular compilation object is
private to Analog.

## Verification

### Unit

`pnpm --filter @strata-sc/server-components test`: 327 passed after the change (aot-integrity: AOT output accepted,
lowered and kept decorators found with their class, aliases and namespaces resolved, a same-named foreign decorator
and non-compiled decorators ignored, strings and comments ignored, partial declarations counted and Angular's own
function definition ignored, message content; plugin: gate fails owned modules in both environments, ignores
dependency decorators, flags unlinked packages, is inert under `vite` dev; barrier holds the first environment
until the second ends, does not wait when environments are sequential, is released by `closeBundle`, is inert
outside builds).

### Packed consumer (`pnpm test:server-component-package-consumer`, Node + local workerd)

Run outside the workspace from the packed tarball. Added to the existing harness (no second infrastructure):

- **Output scan after every build**: no emitted module (SSR bundle, Nitro server, Worker, browser graph) applies an
  Angular decorator; no Vite-owned output (`ssr`, `client`) still calls a partial declaration; the scan saw compiled
  definitions (non-vacuous); a probe directory proves the scan itself detects both violations.
- **Negative control 1, a page outside Angular's program** (`exclude` in `tsconfig.app.json`): Analog skips it and the
  build used to exit 0. Now the build fails with `AOT integrity: "src/app/pages/product.page.ts" (… build)` naming
  `@Component ProductPage`, the JIT consequence and the tsconfig cause, with no absolute path and no source text.
- **Negative control 2, an unlinked partial declaration** appended to the installed Angular package after the linker
  ran: the build fails naming `node_modules/@strata-test/angular-widgets/dist/fesm2022/index.js (ssr build)` and
  "Angular linker did not process this package".
- **Positive control, adversarial environment schedule**: the page's `ssr` transform is held until after the
  `client` `buildEnd`. The build succeeds and the output scan is clean. The log order is asserted, so the schedule
  is proven to have run.
- **Barrier necessity (executed once, not kept as a test)**: with the barrier temporarily neutralized the same
  schedule made the build **fail at the gate** with the integrity error for `product.page.ts` instead of shipping
  a server that cannot render it. With the barrier restored it passes. This shows both that the injector bites and
  that the gate converts the failure into a build error.
- **Cold-start SSR**: a server readied by TCP accept (no HTTP request first, unlike `startNodeServer`, whose
  readiness probe renders `/`) receives one first request, then eight first requests issued behind a barrier (all
  constructed before any is sent), each assessed as a complete document with a clean log. Repeated for
  `STRATA_INTEGRITY_BUILDS` (default 2; the new `integrity` job of the extended workflow uses 10) independent clean
  builds, each followed by its own cold start.
- Every SSR answer (Node and workerd) is classified by `lib/ssr-integrity.ts`: HTTP/type, empty `app-root`, labelled
  server-owned content, protocol and JSON props and `ngh` per island, forbidden server markers, and the server log
  (`build-compilation` for JIT lines, `server-bootstrap` for other errors); browser hydration adds `client-hydration`
  (hydrated, DOM reused, no browser error). Failure details contain counts, labels and one redacted, truncated log
  line. With `STRATA_DIAGNOSTICS_DIR` a content-free JSON record and, on failure, the consumer's SSR JavaScript are
  retained.
- The shared fixture direct-load (`pnpm test:server-components`, `pnpm test:server-components:cloudflare`) applies
  the same assessment. For workerd the log window starts after the earlier deliberate `NG04002` probe line has been
  seen (a late-flushed line from an earlier request is not the direct load's error).

## Results

All local, macOS, Node 22.23.1, 2026-10-22/23. Hosted CI is recorded below once the PR has run.

| Check                                                                                                                                                                                                                               | Result                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Package unit tests                                                                                                                                                                                                                  | **PASS** (327)                                                              |
| Packed consumer, Node production + local workerd, controls, cold starts                                                                                                                                                             | **PASS**, 0 failing checks                                                  |
| Packed consumer with the barrier neutralized (schedule control)                                                                                                                                                                     | **FAIL as designed** at the integrity gate; reverted                        |
| `pnpm test:server-components` (Node)                                                                                                                                                                                                | **PASS**                                                                    |
| `pnpm test:server-components:cloudflare` (local workerd)                                                                                                                                                                            | **PASS** after the log-window fix (see below)                               |
| Remaining local matrix (analog, navigation, defer, server-only, security, request-context, authorization, failures, ssr-response, dev, full-stack consumer and deployed rehearsal, www, relay, www cloudflare build, Entwine 0.5.1) | **PASS**                                                                    |
| Hosted CI on PR #118 (run 39920611112)                                                                                                                                                                                              | **PASS**, all jobs, including the packed consumer on Node and local workerd |

An early workerd run failed the new SSR assessment because of a late-flushed `NG04002` line from the _deliberate_
`/_worker.js/index.js` probe landing in the window. That is a harness window defect, not an SSR defect, and was fixed
by waiting for that exact line (bounded) before marking the log; the fix is not a retry.

## Remaining uncertainty

- The hosted failures were not captured with build output. The mechanism is reproduced and matches their
  signature; it is not proven to be their cause, and absence of recurrence proves nothing about a nondeterministic
  failure. The honest claim is: a reproduced cause is removed, and any recurrence of this class now fails the build
  with a named module.
- The barrier relies on this plugin running ahead of Analog's (`enforce: "pre"`, which Vite orders independently
  of array order) and on Analog 2.7.2's shared-plugin behaviour. Another Analog version needs re-qualification; the
  adversarial schedule is the control.
- The gate sees modules that pass through Vite. Nitro copies other traced, partial-compiled packages
  (`@angular/common`, `@analogjs/content`) into its output unlinked; nothing in the fixtures evaluates them. A
  consumer that makes Nitro evaluate an externalized partial package is not covered. One fixture does not justify a
  universal AOT claim.
- Analog `jit: true` production builds are outside the contract and would now fail the gate.
- An unexpected Angular render error other than a missing compilation still yields HTTP 200 (unchanged,
  [report](server-component-ssr-response.md)).
- Windows was not exercised.
- Not run here: deployed Cloudflare (needs credentials), registry consumer (needs a published version).

## Separate issue (not changed here)

`release.yml` runs on every push to `main` and publishes without depending on the aggregate CI `Verify` result for
the same SHA. This is a cross-cutting release-safety concern recorded as its own issue.

## Verdict

| Question                                                             | Verdict                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Mechanism for the original failure                                   | **Reproduced by fault injection**; attribution to the two hosted runs by signature |
| Fix by supported means (public hooks)                                | **GO**, narrow: barrier plus build-time gate                                       |
| Uncompiled class or unlinked partial declaration reaching production | **Detected at build time** for modules passing through Vite                        |
| Intermittent failure eliminated                                      | **UNCONFIRMED**: mitigated and made deterministic, not proven gone                 |
| Node production SSR                                                  | **CONDITIONAL GO**, local only                                                     |
| Local Cloudflare Pages/workerd                                       | **CONDITIONAL GO**, local only (not a deployment)                                  |
| General unexpected render-error status                               | **NO-GO** (unchanged)                                                              |
| Strata 1.0 / M3 / M4 / M5                                            | **NOT QUALIFIED**; M1 H3 v2 independently blocked upstream                         |

## Hosted CI findings

- `ci.yml` had been an **invalid workflow since #115** (`runner.temp` in job-level `env`): no CI job ran on any push or
  pull request after it. The same mistake was in the new `integrity` job. Both now export the directory from a step.
- The first real hosted run failed two jobs on the Ctrl/Cmd-click navigation check, a pre-existing race (it also failed
  the release run 39781556585 of `main`): the helper read a new tab's URL while it was still `about:blank`. It now waits
  for the URL to change. Neither failure involved the compilation gate or the SSR assessment.
