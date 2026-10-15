# Full-stack external consumer: core + analog + server-components

Date: 2026-10-15  
Baseline: `2f4f37d37c26690b2b7790835a38ecaf2f5ee056` (`main`; the assignment named `25a30c3`, main has since
advanced through PRs #78 and #79 with no overlap)  
Branch: `test/external-full-stack-consumer`

## Verdict first

`pnpm test:full-stack-package-consumer` (172 checks, all passing) installs the three **packed** packages with
`npm` into one Analog app copied outside the workspace and exercises, in that single app:

```text
Strata controller (@strata-sc/core + @strata-sc/analog, Nitro plugin)
    -> public HTTP API  /api/products/:id
    -> interactive Angular island (fetch on click)

server-only repository -> @ServerComponent() -> SSR HTML -> hydrated [strataClient] island
```

It is a fixture, not a real application. It does not qualify production adoption, shared controller/SSR
dependency injection, authentication, CSRF, tenant isolation or a real Cloudflare deployment.

| Verdict                                          | Result                            |
| ------------------------------------------------ | --------------------------------- |
| External packed-package installation             | GO                                |
| Core + Analog controller integration             | GO                                |
| Server Components integration                    | GO                                |
| Interactive Angular island + controller HTTP API | GO                                |
| Node production SSR                              | GO                                |
| Cloudflare local workerd                         | GO                                |
| Server/client confidentiality                    | GO (synthetic canaries, this app) |
| Shared controller/SSR dependency injection       | NOT QUALIFIED                     |
| Real application production adoption             | NOT QUALIFIED                     |
| Complete Cloudflare deployment                   | NOT QUALIFIED                     |
| True SPA Server Component navigation             | UNSUPPORTED                       |
| Streaming SSR                                    | UNSUPPORTED                       |
| Strata 1.0                                       | NOT YET QUALIFIED                 |

## Packages and installation

Manifest versions at the baseline (not a statement about npm publication; nothing was published):

| Package                        | Version | Tarball sha256                                                     |
| ------------------------------ | ------- | ------------------------------------------------------------------ |
| `@strata-sc/core`              | 0.2.1   | `5cca820df06f039519a467db1f4c13ca3d56c8e5d582940251f4574f5c1fcb2e` |
| `@strata-sc/analog`            | 0.2.1   | `74c8d2c69e646e71435c15f1865b45af220527e9d70c51c23181611bdc78610e` |
| `@strata-sc/server-components` | 0.2.0   | `3b205f53ebe05e083e583033c0caf52cc4bcadd15e0ec414d86004c6cc8a04ef` |

Hashes are of the local `pnpm pack` output at this baseline; tarballs embed no timestamps from the build,
but a different dependency state can change them, so the runner prints them on every run instead of
pinning them.

Method (`tools/server-components/full-stack-consumer.ts`): build the three packages, `pnpm pack` each, copy
`tests/full-stack-package-consumer/fixture` (not in `pnpm-workspace.yaml`) to an OS temp directory, replace
the three `REPLACED_BY_RUNNER` ranges with `file:<tarball>` and run `npm install` with an empty user config
and no `npm_*`/`pnpm_*`/`NODE_PATH`/`NODE_OPTIONS`. Every later command is the consumer's own
`node_modules` binary.

No-workspace-resolution evidence, all asserted:

- each installed package is a real directory, at the manifest version, with files byte-identical (sha256) to
  its tarball and no `src/`;
- `package-lock.json` resolves each `@strata-sc/*` entry from `file:` with the tarball's sha512, never a
  registry URL;
- the packed `@strata-sc/analog` depends on `@strata-sc/core` by the concrete version `0.2.1` (pnpm rewrites
  `workspace:*`); from the installed analog directory `@strata-sc/core` resolves to the one top-level packed
  core, and exactly one copy of core, analog and server-components exists;
- all six entries (`core`, `analog`, `server-components`, `/vite`, `/navigation`, `/server-only`) resolve to
  `consumer/node_modules/.../dist/...`, none into the repository; `@strata-sc/h3` is not installed;
- one copy of `@angular/core`, `@angular/compiler` and `typescript`; `npm ls --all` reports no problem for a
  Strata, Angular, Analog, Vite, TypeScript or Nitro package.

## Installed tuple

Node v22.23.1; `@angular/{core,common,compiler,router,platform-browser,platform-server,compiler-cli}`
22.1.7, `@angular/build` 22.1.8; `@analogjs/{platform,router,vite-plugin-angular}` 2.7.2,
`@analogjs/vite-plugin-nitro` 2.8.1; `nitropack` 2.13.4; `h3` 1.15.11; `vite` 8.3.0; `typescript` 6.0.3
(declarations also under 5.9.2); `rxjs` 7.8.2; `tslib` 2.8.1; `wrangler` 4.135.0 (the consumer's own).
Cloudflare: `wrangler pages dev` with `--compatibility-date 2026-09-21` and **no** compatibility flags
(`nodejs_compat` is not enabled; the Worker graph's externals contain no `node:` import).

## What the app contains

- **Controller** (`src/server/strata/products.controller.ts`): standard ECMAScript decorators from
  `@strata-sc/core`; `GET /api/products/:id` returns `{ id, name, available }`, a controller-returned
  `Response` with status 404 `{"error":"not_found"}` for an unknown id (H3 honours the returned web
  `Response`; that is H3 behaviour, the adapter passes results through), and `GET /api/products/:id/lifecycle`.
  It is registered by `registerControllers(nitroApp.router, ...)` in `src/server/plugins/strata.ts`. Nitro
  lowers it with esbuild's standard-decorator helpers (`__decorateElement`); the gate asserts no legacy
  `__decorate`, no `reflect-metadata`.
- **Native Nitro routes** `/api/native` and `/api/lifecycle-stats` keep working next to it. The stats route
  exposes a qualification-only counter (controller instances created and cleaned); it is not product data.
- **Server Component** (`src/app/products/product-details.server-component.ts`) reads
  `ProductRepository` (`import "@strata-sc/server-components/server-only"`), renders the title, a
  server-computed tier and the island. The repository consumes a confidential supplier cost
  (`7391047`) and note (`FULLSTACK_PRIVATE_SUPPLIER_CANARY_9f3c`): the cost only decides the public tier, the
  note is only hashed into `data-evidence`. Neither is returned or rendered.
- **Island** (`product-availability.component.ts`): "Refresh availability" calls `fetch("/api/products/42")`
  and shows the public result. It imports neither the controller nor any server-only module.
- **Navigation**: `/` offers a plain-`href` link and a `routerLink` to `/products/42?ref=home#details`;
  `products.[id].page.ts` opts in with `strataDocumentNavigationGuard` from
  `@strata-sc/server-components/navigation`.
- Vite config is the documented setup: the Strata plugin ahead of Analog, `generatedDir` under
  `src/generated/server-components` (included by `tsconfig.app.json`), `ssr.noExternal: ["tslib"]`.
  `@defer` is unused, so the `ngServerMode` workaround is not needed.

## Two server runtimes, kept separate

The controller and Angular SSR share nothing by design, and the fixture does not pretend otherwise:

| Aspect        | Controller runtime                                           | Angular SSR runtime                                                                        |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Created where | Nitro plugin; `new Controller()` in the factory, per request | Angular's per-render injector (`ProductRepository` is `providedIn: "root"` of that render) |
| Data source   | `src/server/strata/product-catalog.ts` (deterministic, own)  | `src/app/products/product.repository.ts` (deterministic, own)                              |
| Request data  | `StrataAnalogRequest` params                                 | route param read from `ActivatedRoute`, passed as an input                                 |
| Public        | `{ id, name, available }`, `x-fullstack-catalog` fingerprint | rendered HTML, `data-strata-props` `{"productId":"42"}`                                    |
| Server-only   | catalog marker, factory, stats                               | repository, helper, cost, note, implementation marker                                      |

Both pages showing "Product 42" is deliberate duplication of a deterministic fact, not shared state. The
island reaches the controller only through a public HTTP request. No shared injector, singleton or
module-level state is assumed.

## Evidence (Node and workerd run the same suites)

HTTP: controller 200 JSON, header fingerprint proving the handler ran, path parameter, 404 for an unknown id,
repeated requests, 11 requests (3 sequential, 8 concurrent) each with its own controller instance
(`calls === 1`, distinct instances) and the factory creating and cleaning exactly +11/+11, native route,
SSR page with title/tier/`data-evidence` (recomputed from every server-only value, so the repository
really ran), protocol-v1 boundary with `ngh` and exactly `{"productId":"42"}` props, not-found branch for
`/products/999` (status stays 200: documented soft 404, not a status contract).

Browser (Chromium): application scripts held back, SSR DOM tagged, scripts released, island hydrates reusing
the heading, button, output and its text node; no leftover `ngh`; exactly one island; one click sends
exactly one `fetch`, receives the public JSON and changes the Angular state exactly once; no console
error or warning. Navigation: document link, Back (fresh state), Forward, and the opt-in guard turning an
Angular Router link into one real document request preserving `?ref=home#details`, then Back/Forward.
This is full-document navigation, not SPA navigation.

Graph and confidentiality: six canaries (five server-only markers plus the cost) are absent from every
browser file and source map, from the SSR HTML, hydration metadata, props, API JSON and headers, the
hydrated DOM and every document/script/API body Chromium received, and present in the Node server graph
(markers) and the Worker graph. Browser maps list neither the consumer's server files nor
`@strata-sc/core`/`analog`; no browser script contains `registerControllers`, `getControllerDefinition` or
`ProductsController`. The server-only firewall still fails the production build when an island imports the
repository, naming the importer and the fix, without printing a canary.

Declarations: TypeScript 6.0.3 and 5.9.2 compile two consumer projects (Angular decorators for
server-components and `/navigation`; standard-decorator controllers for core and analog) with `strict` and
`skipLibCheck: false`, 0 diagnostics, reading all six declaration entry files from `node_modules`.

## Negative control

With the `registerControllers` call removed from the fixture's plugin, the gate fails (the API returns
Angular's HTML instead of JSON). The gate also fails on a missing tarball install, a non-`file:` lock entry,
a second core copy, a skipped Cloudflare phase (verdict) and any canary in browser output.

## Limitations

- Unmatched paths under `/api/` fall through to Analog's SSR catch-all (HTML, Angular `NG04002` logged), not
  to a JSON 404; only resources a Strata route matched can return the controller's 404. Observed on this
  tuple, not changed here.
- `/products/999` renders the not-found branch with status 200 (a soft 404). Real status control uses the
  separate Analog `RESPONSE` seam ([report](server-component-ssr-response.md)); unexpected render errors can
  still return 200.
- Controller and Angular DI are independent; shared-injector integration is NOT QUALIFIED.
- No dev server in this gate (covered by the package-consumer gate); no authentication, CSRF, CORS, tenant
  isolation or caching is claimed. The deployed-Cloudflare gate is unrelated and unchanged.
- A fixture is not a real application: real-application adoption stays NOT QUALIFIED; local workerd is not a
  Cloudflare deployment. `@strata-sc/h3` and its upstream H3 v2 type issue are out of scope.

## Reproduction

```bash
pnpm test:full-stack-package-consumer
STRATA_KEEP_CONSUMER=1 pnpm test:full-stack-package-consumer   # keep the temp consumer for inspection
```

Existing gates are unchanged: `test:package-consumer` (core + analog), `test:server-component-package-consumer`
and `test:server-component-registry-consumer` (server-components alone). The only shared-helper change is an
optional `readyPath` argument on `startWrangler` (default unchanged).
