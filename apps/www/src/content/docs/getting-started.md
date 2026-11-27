---
title: "Getting started"
description: "What Strata publishes, what it needs, and where to begin."
group: "Start here"
order: 1
---

<!-- Generated from docs/GETTING-STARTED.md by apps/www/scripts/public-docs.ts. Do not edit. -->

Strata is **experimental**. `1.0.0-rc.0` is a release candidate for evaluation, not a stable release. Read
[Compatibility](/docs/compatibility) for exactly what is supported before depending on it. This page orients you
and never overrides that contract.

## What is published

| Package                                                                   | Role                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`@strata-sc/core`](/docs/packages/core)                           | `@Controller` and HTTP method decorators (standard decorators)         |
| [`@strata-sc/analog`](/docs/packages/analog)                       | Registers controllers on the Nitro router that Analog runs on          |
| [`@strata-sc/server-components`](/docs/packages/server-components) | Server Components with explicit `[strataClient]` islands, document SSR |
| [`@strata-sc/h3`](https://github.com/Andersseen/Strata/blob/main/packages/h3/package.json)                            | **Private, not published.** H3 v2 adapter, blocked upstream (SPEC-002) |

The three public packages are released together as one tuple, on two npm channels
([ADR-005](https://github.com/Andersseen/Strata/blob/main/docs/adr/005-npm-dist-tag-channels.md)):

| Channel  | Tuple                                                     | Use it for                           |
| -------- | --------------------------------------------------------- | ------------------------------------ |
| `latest` | core `0.2.2`, analog `0.13.0`, server-components `0.17.0` | existing 0.x applications            |
| `next`   | all three at `1.0.0-rc.0`                                 | evaluating the 1.0 release candidate |

`latest` stays on the 0.x line until a stable 1.0 is authorized; nothing moves it to a release candidate. `0.x`
releases may break in any minor.

## Install

Evaluate the release candidate with exact versions:

```bash
pnpm add -E @strata-sc/core@1.0.0-rc.0 \
  @strata-sc/analog@1.0.0-rc.0 \
  @strata-sc/server-components@1.0.0-rc.0
```

Keep the existing 0.x tuple with exact versions as well:

```bash
pnpm add -E @strata-sc/core@0.2.2 @strata-sc/analog@0.13.0 @strata-sc/server-components@0.17.0
```

**Why exact versions.** The contract covers one tuple, all three packages at the same `1.0.0-rc.N`. `@next`
is a moving pointer: a later `rc.N+1` moves it, and a later install would then mix or replace tuples behind
your back. `-E` writes the exact version into `package.json`, so a reinstall, a teammate and CI resolve the
tuple you evaluated. `@strata-sc/analog@1.0.0-rc.0` itself pins `@strata-sc/core@1.0.0-rc.0` exactly, so no
0.x copy can join the tuple. Commit the lockfile.

Install from the registry, never from a link to a checkout of this repository.

## Supported tuple, declared ranges and what is not supported

These are four different things. Only the first is a promise.

| What                     | Where it is defined                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supported tuple**      | One exact framework tuple, below. Anything else is unqualified (`NO-OTHER`).                                                                                                                |
| **Declared peer ranges** | `@angular/*` `^22.1.7`, TypeScript `^5.9.0 \|\| ^6.0.0`, Vite `>=8.3.0 <9`: what npm accepts, not a support claim                                                                           |
| **Experimental**         | `EX-*` in [Compatibility](/docs/compatibility#experimental): `@defer`, `serverFn`, `streamResponse()`, observation hooks, Angular DI in controllers                                            |
| **Unsupported**          | `NO-*` in [Compatibility](/docs/compatibility#unsupported): streaming SSR, SPA subtree navigation, JIT integrations on workerd, the H3 v2 adapter, a TLS-terminating proxy in front of Node, … |

**The supported tuple** ([RC0 support contract](/docs/compatibility#rc0-support-contract)):

| Component  | Version                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| Node.js    | 22                                                                        |
| Angular    | 22.2.7 (every `@angular/*` package, `@angular/build` too)                 |
| Analog     | 2.9.7 (platform, Angular and Nitro Vite plugins); router 2.8.1            |
| Nitro, H3  | nitropack 2.13.6, h3 1.15.11                                              |
| Vite       | 8.3.8                                                                     |
| TypeScript | 6.0.3 or 5.9.2                                                            |
| Cloudflare | Wrangler 4.161.0, compatibility date `2026-09-21`, no compatibility flags |

Another Angular, even one npm accepts inside `^22.1.7`, is outside the contract until it is qualified.
Developing this repository itself needs Node.js `>=22.22.3` and pnpm `10.30.1`.

## A minimal application, step by step

Each step names the real API and links the file that proves it: the
[external full-stack consumer](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/package.json) that every
qualification installs from npm or from packed tarballs outside this workspace, builds for Node and Cloudflare
Pages, and type-checks against the installed declarations with TypeScript 6.0.3 and 5.9.2 and
`skipLibCheck: false`. Copy from those files: they are compiled and run, and these short notes are not.

1. **Prepare an Analog application on the supported tuple.** Start from the stock Analog template and pin the
   framework versions above. The fixture's [`package.json`](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/package.json)
   is a complete, qualified dependency list.
2. **Install the exact Strata tuple** with the command above.
3. **Register a controller.** Decorate a class with `@Controller` and `@Get`/`@Post`/… from `@strata-sc/core`,
   then call `registerControllers(nitroApp.router, [MyController], options)` from `@strata-sc/analog` in a
   Nitro plugin ([plugin](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/server/plugins/strata.ts),
   [controller](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/server/strata/products.controller.ts)).
   Add `apiBoundary: { prefixes: ["/api"] }` to make `/api` a real namespace: JSON `404`, `405` with `Allow`
   instead of Analog's HTML fallback.
4. **Validate a request.** `request.readValidatedJson(schema)`, `readValidatedForm`, `validateParams`,
   `validateQuery` and `validateHeaders` accept any [Standard Schema](https://standardschema.dev) (the fixture
   uses zod 4). An invalid input becomes a safe `400`; use `StrataAnalogHttpError`, `jsonResponse()` and
   `noContent()` for explicit statuses
   ([example](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/check/http-contract-example.ts)).
5. **Own authorization.** Strata ships no authentication. Resolve the principal in your code and refuse in a
   guard, `{ allow: false, status: 401 | 403 }`, before any repository read
   ([policy](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/server/strata/tenant-authorization.ts),
   [guarded controller](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/server/strata/protected.controller.ts)).
   Build per-request dependencies in `controllerFactory` and release them with `onCleanup`; Strata creates a
   controller per request and keeps nothing between requests.
6. **Set `publicOrigin`.** Pass your deployment's origin to `registerControllers(..., { publicOrigin })`. It is
   the only origin a same-origin or CSRF check may trust; `X-Forwarded-*` and `Forwarded` are never trusted
   ([plugin](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/server/plugins/request-origin.ts),
   [S-1 contract](/docs/compatibility#rc0-support-contract)).
7. **Configure Server Components.** Add `strataServerComponents({ root, sourceDir, generatedDir })` from
   `@strata-sc/server-components/vite` **before** `analog()`, and `ssr.noExternal: ["tslib"]`
   ([vite.config.ts](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/vite.config.ts)).
8. **Render a server-only component.** Mark it `@ServerComponent()`, and put repositories and secret loaders
   in modules that start with `import "@strata-sc/server-components/server-only"`
   ([component](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/app/products/product-details.server-component.ts),
   [repository](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/app/products/product.repository.ts)). The build
   refuses a browser graph that reaches a marked module, through any path or package. Unmarked modules are not
   protected (`NO-UNMARKED`).
9. **Add an interactive island.** Inside the Server Component, give an ordinary Angular component a
   `[strataClient]` binding with a public view model and import `StrataClientBoundary`
   ([island](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/app/products/product-availability.component.ts)).
   Everything passed through `[strataClient]` becomes browser-visible. An island reaches the server only through
   public HTTP, never by importing server code.
10. **Integrate both halves of the SSR failure contract.** Wrap the render with `withStrataSsrFailureContract`
    in [`main.server.ts`](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/main.server.ts) and register
    `provideStrataSsrFailureHandler(RESPONSE)` in the
    [server application config](https://github.com/Andersseen/Strata/blob/main/tests/full-stack-package-consumer/fixture/src/app/app.config.server.ts),
    both from `@strata-sc/server-components/ssr`. Without them, a failed render can still answer HTTP 200.
11. **Build for Node:** `vite build`, then `node dist/analog/server/index.mjs` (Nitro `node-server`).
12. **Build for Cloudflare Pages:** `BUILD_PRESET=cloudflare-pages vite build`, with the compatibility date
    `2026-09-21` and no flags. Angular DI in controllers and `serverFn` need JIT, which workerd does not run
    (`NO-JIT-WORKERD`); keep controller factories plain TypeScript there.
13. **Upgrade from the previous tuple.** Change all three versions at once, rebuild, and deploy with a **new**
    `buildId`. Give the Strata plugin a distinct deployment label per build (`buildId: process.env.RELEASE_ID`)
    and opt into `provideSkewRecovery({ reload: true })`: a browser holding the old build then gets one bounded
    reload instead of hydrating mismatched islands
    ([deployment compatibility](/docs/packages/server-components#deployment-compatibility)). Never
    derive `buildId` from a package version: two builds of one version are still two deployments.
14. **Roll back safely.** Redeploy the retained previous build. Keep each deployment's immutable assets
    available, so a tab that loaded the newer document can still fetch what it references. Never republish or
    unpublish a version on npm.

## Troubleshooting

| Symptom                                                                                       | Cause and fix                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It installs, but behaves differently from these docs                                          | **Unsupported Angular.** npm accepts any `@angular/*` inside `^22.1.7`; only 22.2.7 is qualified. Pin every `@angular/*` to 22.2.7.                                                                                                                                  |
| `npm ls @strata-sc/core` shows two versions, or a `0.x` beside an RC                          | **Wrong package tuple.** Install all three at the same exact version with `-E`. A mix of RC and `0.x` is outside the contract.                                                                                                                                       |
| Every SSR page answers 500 (phase `integration`) after adding a library                       | **Duplicate installation.** `/ssr` refuses a `@strata-sc/server-components` copy ≤ 0.16 next to a newer one, and a library that loads its own second `@angular/core` (add it to `ssr.noExternal`). Deduplicate so `npm ls` shows one copy of each (`NO-DUPLICATES`). |
| Every SSR request answers HTTP 500, or the server bootstrap is rejected                       | **Missing SSR integration half.** A wrapper without `provideStrataSsrFailureHandler` fails every request; a provider without a compatible wrapper rejects the bootstrap. Register both (step 10).                                                                    |
| A failed render answers HTTP 200 with an empty component                                      | **Neither SSR half is registered.** That is Angular and Analog's buffered behaviour; add both halves (step 10).                                                                                                                                                      |
| `vite build` fails naming a server-only module and the island that reaches it                 | **Server-only import violation.** An island's graph reaches a module marked `server-only` (directly, through an alias, a barrel or a package). Share only DTO types with islands; move the import to the Server Component.                                           |
| An island renders but never becomes interactive; `ErrorHandler` reports `StrataBoundaryError` | **Hydration refusal.** Preflight refused that host (invalid or over-budget props, an unknown client reference). The whole host stays inert and its SSR DOM is kept; the error's `category` names the reason. Observe it with `provideStrataHydrationObserver`.       |
| `StrataBuildMismatchError` (`build-mismatch`), and the page reloads once                      | **Build identity mismatch.** The document and the browser script come from different deployments. Expected during a rollout with `provideSkewRecovery({ reload: true })`; persistent mismatches mean old documents are cached or assets are not retained.            |
| A same-origin or CSRF check rejects real users, or accepts a spoofed host                     | **Incorrect `publicOrigin`.** Without it, `request.url.origin` describes the connection (behind a proxy, its plain `http://` hop). Set `publicOrigin` to the public origin and compare only with it (step 6).                                                        |
| A controller using Angular DI or `serverFn` fails on Cloudflare Pages                         | **Unsupported workerd JIT integration** (`NO-JIT-WORKERD`). It fails safely; use a plain TypeScript `controllerFactory` on workerd.                                                                                                                                  |

## Pick a path

1. **HTTP controllers in an Analog app**: [Controllers and server integrations](/docs/integrations), then the
   [Analog adapter reference](/docs/packages/analog).
2. **Server Components**: [Server Components](/docs/integrations#server-components), then the
   [package reference](/docs/packages/server-components), including the
   [server-only recipe](/docs/packages/server-components#server-only-recipe) and
   [external Angular package islands](/docs/packages/server-components#external-angular-package-islands).
3. **The design**: [Architecture](https://github.com/Andersseen/Strata/blob/main/docs/ARCHITECTURE.md), [Vision](https://github.com/Andersseen/Strata/blob/main/docs/VISION.md) and the accepted
   [ADRs](https://github.com/Andersseen/Strata/blob/main/docs/README.md#accepted-decisions).

The package READMEs on npm are the copies inside the published tarballs. Where they and this page differ on
versions, this page and [Compatibility](/docs/compatibility) are current.

## Run the repository locally

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Examples that exercise the packages in a real Analog application:

| Application                                                  | Purpose                                                                                              | Run                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------ |
| [`apps/www`](https://github.com/Andersseen/Strata/blob/main/apps/www/package.json)                       | Official website; its homepage dogfoods one Server Component. Deployed to Cloudflare Pages.          | `pnpm www:dev`     |
| [`apps/relay`](https://github.com/Andersseen/Strata/blob/main/apps/relay/package.json)                   | Private, local-only operations console using controllers and Server Components. Not deployed.        | `pnpm relay:dev`   |
| [`apps/analog-fixture`](https://github.com/Andersseen/Strata/blob/main/apps/analog-fixture/package.json) | Test fixture behind `pnpm test:analog`, `pnpm test:server-components` and the navigation experiments | `pnpm test:analog` |

Qualification commands are described in [Testing strategy](https://github.com/Andersseen/Strata/blob/main/docs/TESTING.md).
