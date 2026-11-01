# Installed Angular package islands: production qualification (M4 slice)

Status: **PACKED-CONSUMER QUALIFIED locally** on the feature branch; hosted CI is pending and nothing is
deployed or published. This is a bounded slice of M4, not M4 and not a 1.0 claim.

## Scope and starting point

- Starting `origin/main` SHA: `4baa004fa92b78e725f0ae340c2f39c4af054bcc` (PR #156 merged).
- Feature branch: `feat/server-components-installed-island-qualification`.
- Versions at start: `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.12.0, `@strata-sc/server-components` 0.13.0.
- Resolved tuple of the outside-workspace consumer (npm install, recorded from `node_modules`): Angular
  22.2.3 (`@angular/build` 22.1.8), Analog platform/vite-plugin-angular 2.7.2, Analog router 2.8.1, Vite 8.3.0,
  TypeScript 6.0.3, nitropack 2.13.5, wrangler 4.135.0, Node 22.23.1, Chromium from the repository's Playwright.
  Local evidence on macOS arm64 (Apple M4); it is not a support declaration.
- Artifacts: the real `pnpm pack` tarball of `@strata-sc/server-components` and **two** independently
  partial-compiled (`ngc`, `compilationMode: "partial"`) tarballs of a private test library,
  `@strata-test/angular-widgets` (`0.0.0-test` and `0.0.1-test`), all installed with `npm install` into a
  consumer copied to the OS temp directory. No workspace alias, symlink or relative import is involved.

## Audit: what already existed, and the exact remaining gaps

Already implemented and preserved (not duplicated): explicit `clientComponents` registry; exact named-import
matching; generated surrogates with `{ type, expectedSelector }` descriptors; the runtime registry builder
(`buildClientReferenceRegistry`: selector mismatch, selector conflict, non-component, reflection exceptions,
descriptor read without invoking accessors); host-atomic preflight; protocol v1/v2 and the 128-boundary /
1 MiB budgets; the observer and ErrorHandler contract; build identity and skew recovery; the server-only
graph firewall and dependency-optimizer firewall; the packed positive consumer (Node, `vite` dev, workerd).

Gaps recorded before any code change:

1. No installed-package **build-time** negative matrix (selector mismatch, conflicting owners,
   non-component, directive, missing export).
2. No **browser-time** refusal tests against the installed library; descriptor negatives were unit-only or
   used the local `failures` fixture.
3. A descriptor with an **extra own property** was accepted silently (reproduced by a failing unit test).
4. No installed-package **upgrade**, downgrade, clean/warm Vite cache or `--force` characterization.
5. No measurement of the installed-reference path, and no sibling host with a _different_ installed component.
6. No server-only canary scan with a negative control for the installed-island build.

## What changed

Package (one behavior change, hence the minor Changeset):

- `buildClientReferenceRegistry` refuses a descriptor that owns any key besides `type` and `expectedSelector`
  (`Reflect.ownKeys`: data properties, accessors, symbols and non-enumerable keys all count). The refusal is a
  `reference` failure that names the position only, never the key, and no extra property is read. Generated
  surrogates emit exactly two keys, so they are unaffected. Plain component types in the array stay valid.
  Regression: four new unit cases (`K`) failed before the change and pass after it.

Fixtures and tools (no package behavior):

- `angular-widgets`: `negatives` entry (mismatched selector, duplicate-selector component, directive, plain
  class, non-class export) and `second` entry (`acme-stock-badge`, a different component with an aliased input).
- Consumer fixture: `stock-panel` (a second Server Component with the `second` island) and the `/mixed` page
  that hosts it beside `product-details`; one extra registry entry.
- `pnpm test:server-component-installed-island` (also a step of the `consumers` CI job) and
  `pnpm test:server-component-installed-island-performance` (manual; never gated on a time).

## Positive consumer (Node and workerd)

- The installed library contains `ɵɵngDeclareComponent` only; the production bundles contain no unlinked
  partial declaration and no uncompiled decorated class (the repository's output scan, with its own controls),
  i.e. Angular's linker processed the installed component for the server and the browser graphs.
- `/mixed` renders two Server Components with two different installed components; the browser hydrates both
  over the SSR DOM, the picker reacts to a click and the badge reacts to a click.
- Node and local workerd (`wrangler pages dev`, the consumer's own wrangler) pass the same matrix.

## Enforcement layers and the complete negative matrix

Build time (the compiler fails closed where the reference is statically visible; nothing is weakened):

| Case                                                      | Build outcome                                                                                                            | Source of the diagnostic        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| B: registered export declares another selector            | **fails**: `Can't bind to 'productView'… 'acme-product-picker'`                                                          | Angular AOT (NG8002)            |
| C: two components claim one selector in one template      | **fails**: `Multiple components match node with tagname …`                                                               | Angular AOT                     |
| C: two registry entries claim one selector                | **fails**: `[strata] duplicate client component selector …`                                                              | Strata, at plugin configuration |
| D: plain class registered                                 | **fails**: `Component imports must be standalone …` or `[strata] AOT integrity` (the first reporter varies between runs) | Angular AOT or Strata           |
| D: non-class export registered                            | **fails** (`[strata] AOT integrity` or a type error)                                                                     | Strata / TypeScript             |
| D: registered export that does not exist                  | **fails**                                                                                                                | Strata AOT integrity / bundler  |
| Unregistered package component used with `[strataClient]` | **fails**: `<…> is marked [strataClient] … but no import …`                                                              | Strata analyzer                 |
| E: **directive** registered as a client component         | **builds**                                                                                                               | none — see below                |
| K: repeated references to one valid component             | builds, hydrates                                                                                                         | —                               |

Case E is the one reproduced gap in static visibility: Angular accepts a directive whose selector matches the
element and Strata does not read package sources, so the build cannot know. It is therefore enforced in the
browser, and the qualification builds that exact consumer for real and requires the browser refusal (`reference`
category, zero committed boundaries). It is not weakened or hidden: it is a **documented runtime-only case**.

Browser time (each case loads `/mixed`; what is mutated is stated; the page and the Strata runtime are untouched):

| Case                            | Mutation                                                                   | Result               |
| ------------------------------- | -------------------------------------------------------------------------- | -------------------- |
| control                         | none                                                                       | both hosts commit    |
| K repeated valid reference      | picker descriptor duplicated in the surrogate chunk                        | commits              |
| unregistered selector in markup | first picker boundary renamed to `<acme-unregistered-picker>`              | refused, `reference` |
| B mismatch                      | `expectedSelector` rewritten to `acme-other-picker`                        | refused, `reference` |
| C conflict                      | a second descriptor lists an empty subclass (same selector, distinct type) | refused, `reference` |
| D non-component                 | descriptor `type` becomes an empty class                                   | refused, `reference` |
| E invalid metadata              | `type` is a class whose `ɵcmp` getter throws                               | refused, `reference` |
| F malformed                     | `expectedSelector` is `5`; or the key is missing                           | refused, `reference` |
| G hostile accessor              | `expectedSelector` is a throwing getter that counts calls                  | refused; **0 calls** |
| H extra field                   | descriptor gains `extra: 1`                                                | refused (new)        |
| E (real build, no mutation)     | directive registered at build time                                         | refused, `reference` |

Every refused case asserts: one observation, `preflight-refused`, `failureCategory: "reference"`,
`committedBoundaries: 0`, no build mismatch; exactly one `StrataBoundaryError` of category `reference` reached
`ErrorHandler` with the expected diagnostic text and one console error; zero `[data-strata-hydrated]` in the
host and an unresponsive picker; every SSR node of the host keeps identity, order and text; the healthy sibling
host (a different Server Component with a different installed component) commits and its button works; a
single document navigation (no reload), no build mismatch, no `unhandledrejection`, no page error; no canary in
any message; no repeated report after a settle period. Boundary I (one invalid boundary among valid ones) is
inherent to each case: the refused host also holds a valid local `add-to-cart`, a valid `legacy-counter`, and a
valid second picker, none of which hydrate. Boundary J (invalid host beside healthy host) is the sibling
assertion. Case L is covered under upgrades.

## Package upgrades and the optimizer (clean vs warm cache)

| Scenario                                                             | Observation                                  | Classification                              |
| -------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Fresh install, production build                                      | v1 in the browser and server graph           | Supported                                   |
| `vite` dev, clean cache; restart with warm cache                     | SSR v1, prebundle v1, unchanged              | Supported                                   |
| `npm install --no-save` of v2 (lockfile bytes unchanged), warm cache | SSR v2, **browser prebundle followed to v2** | Supported with a dev-server restart         |
| `vite --force` after the upgrade; clean cache after the upgrade      | v2                                           | Supported                                   |
| Production rebuild after the upgrade                                 | v2 only; no v1 marker remains                | Supported                                   |
| Valid v2 changes (new optional aliased input, new subpath export)    | the same registration shape builds           | Supported                                   |
| Downgrade to v1 while the source uses a v2 input/export              | production build fails closed                | Supported (case L)                          |
| Installed file edited **in place** under `node_modules`, warm cache  | SSR v2, browser prebundle **stayed v1**      | Reproduced upstream limitation; unsupported |

No Strata defect was reproduced in this area. The earlier report's warm-cache observation reproduces only for
an in-place edit of `node_modules`, which Vite's optimizer does not watch; an npm upgrade re-optimized in the one
trial run here (a single observation, not a statistical claim). Strata does not patch Vite. Development behavior is not promoted to a production compatibility
promise: the production build reads installed files and is the only supported path after an upgrade.

## Confidentiality

Synthetic canaries (`EXTERNAL_CONSUMER_*`) from the consumer's server sources were absent from every browser
file (entry, lazy chunks, preload assets, `.html`, manifests), from the hidden source maps (whose `sources` list
the installed library but no server file), from the generated surrogate, and from a public error response, and
present in the Node server and Worker graphs. A negative control writes a canary and a server source path into a
synthetic browser file and requires the same scan to find both. Direct, aliased, barrel and `?raw` forms remain
covered by the existing firewall tests in `pnpm test:server-component-package-consumer`; the optimizer firewall
is unchanged. Strata still does not scan arbitrary files in `node_modules`.

## Measurements

Environment: Apple M4 (10 logical cores), macOS 25.6 (Darwin), Node 22.23.1, Angular 22.2.3, Vite 8.3.0,
Chromium via Playwright, Nitro Node server on loopback; one machine, no throttling. Browser rows: 11 samples per
variant, each a fresh browser context after one discarded warm-up load; `elapsedMs` is the monotonic duration of
preflight plus commit for the host, as reported by the observer (preflight and commit are not separable).

Registry construction (isolated, built package, JIT metadata; 20 samples × 2,000 iterations). Two complete runs:

| Case                         | Run 1 median (min–max) µs | Run 2 median (min–max) µs |
| ---------------------------- | ------------------------- | ------------------------- |
| 1 distinct component         | 3.2 (1.4–25)              | 2.0 (1.4–6.9)             |
| 8 distinct                   | 53 (23–104)               | 18.8 (16.8–32)            |
| 32 distinct                  | 300 (155–572)             | 87 (75–123)               |
| 32 repeated to one component | 273 (68–403)              | 80 (63–141)               |

The two runs differ by up to 3×, so no precise per-reference figure is claimed: the cost is tens of µs per host
for eight references and below a millisecond for 32, once per host. It reflects each listed reference even when
the type repeats; no optimization is justified at this magnitude, and surrogates list each component once.

Hydration, preflight + commit per host (run 2; ms): local counter ×1 / ×8 / ×32: 0.70 / 1.20 / 2.50 (MAD ≤ 0.2);
installed picker ×1 / ×8 / ×32: 0.80 / 1.40 / 2.50; mixed 16 pickers + 16 badges: 2.70. Load-to-committed medians
were 55–67 ms for every variant; differences between local and installed variants are within the observed noise.

Sizes (one production build of all variants):

| Variant       | Generated module (B) | Browser chunk raw / gzip (B) | Server chunk raw / gzip (B) |
| ------------- | -------------------- | ---------------------------- | --------------------------- |
| local ×1      | 793                  | 664 / 389                    | 2,313 / 812                 |
| local ×8      | 793                  | 664 / 390                    | 3,120 / 877                 |
| local ×32     | 796                  | 667 / 391                    | 5,934 / 1,039               |
| installed ×1  | 787                  | 659 / 392                    | 2,400 / 826                 |
| installed ×8  | 787                  | 659 / 392                    | 3,403 / 892                 |
| installed ×32 | 790                  | 662 / 394                    | 6,904 / 1,061               |
| mixed ×32     | 928                  | 742 / 425                    | 7,268 / 1,166               |

The generated reference module and the browser chunk do not grow with the number of boundaries (boundaries live
in the server template); the server chunk grows roughly 117 B (local) to 146 B (installed) of compiled template per
boundary (slope between 8 and 32 boundaries). The page's total JavaScript was 297,381 B (91,557 B gzip) for the local page and 298,356 B (92,011 B
gzip) for the installed page: +975 B raw / +454 B gzip, which is the installed library's own component code.

Development optimizer: the registered library was prebundled in every run (25 prebundled files). Dev server
ready time was 6.0–6.5 s with a clean cache and 5.7–10.5 s with a warm cache over three runs each, so no
clean/warm difference is claimed; the first SSR request took 134–225 ms. No production change was made on the
basis of these numbers.

## Local verification

See "Verification" at the end of this document for the command matrix and the hosted-CI status.

## Supported package shapes and limits

Supported (qualified on this tuple, with this fixture): a standalone Angular component exported by name from a
package entry point that ships Angular Package Format FESM with **partial** declarations, registered explicitly
in `clientComponents` with its real selector, imported by the same name into the Server Component's `imports`,
with public (including aliased) inputs and a v1 or v2 boundary payload; several different installed components
in different Server Components; repeated boundaries of one component.

Unsupported or unproven: arbitrary npm Angular components; NgModule-only libraries; components needing router,
HTTP, global providers or content projection across the boundary; barrels, namespace and default imports;
library sources shipped as JIT/decorator code; Angular Router SPA subtree navigation; streaming SSR; shared
SSR/controller DI; selector or export changes that are not reflected in the registry (restart and rebuild);
editing `node_modules` in place under a warm dev cache.

## Remaining limitations

- Hosted CI for the new gate, a deployed Cloudflare Pages run and a production adoption are not claimed.
- Only a private test library was installed; no third-party library was qualified.
- A directive registered as a component is enforced only in the browser.
- Timing figures come from one machine; the registry microbenchmark varied 3× between two runs.
- The earlier warm-cache report is not reproduced for npm upgrades; only an in-place edit reproduces it, and
  only as an upstream limitation.
- Issue #117 stays open: no release-transition evidence was produced here.

## Verification

Local, feature branch, macOS arm64, Node 22.23.1 (all exit 0 unless stated):

- `pnpm install --frozen-lockfile`, `build`, `typecheck`, `test`, `format:check`; `lint` has 0 errors (5 warnings,
  none in new code paths beyond import-order autofixes already applied).
- `pnpm test:server-component-installed-island`: **286 checks, 0 failing** from a clean workspace (about 8 min).
- `pnpm test:server-component-package-consumer` (with the extended fixture), `test:server-components`,
  `-failures`, `-security`, `-server-only`, `-dev`, `-optimized-deps`, `-navigation`, `-defer`, `-request-context`,
  `-authorization`, `-ssr-response`, `-deployment-skew`, `test:server-components:cloudflare`, `test:analog`,
  `-streaming`, `-observability`, `-correlation`, `-headers`, `-forms`, `test:full-stack-package-consumer`,
  `test:analog-packed-di-consumer`, `test:package-consumer`, `test:www:server-components`,
  `test:relay:server-components`, `www:build:cloudflare`, `changeset status`, `release:packages:dry-run`,
  `release:sync-dist-tags:dry-run`: all pass. `pnpm relay:test:e2e`: 6 passed.
- Package unit tests: 397 passed, including the four new descriptor-extra-key cases (they failed before the fix).

Not reproduced locally: `test:server-component-registry-consumer` (needs a published
`STRATA_SC_REGISTRY_VERSION`); `pnpm www:test:e2e` invoked directly (an unrelated `next-server` owns
`127.0.0.1:3000` and Playwright reuses it; the same suite passes through `test:www:server-components` on fresh
ports); the repository-pinned Entwine CLI is not installed locally; deployed Cloudflare checks need an account.
Hosted GitHub Actions status is recorded in the PR.
