<p align="center">
  <img src="./apps/www/public/strata-mark.svg" width="96" height="96" alt="Strata logo" />
</p>

# Strata

[![CI](https://github.com/Andersseen/Strata/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Andersseen/Strata/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Andersseen/Strata?display_name=tag&sort=semver)](https://github.com/Andersseen/Strata/releases)
[![License](https://img.shields.io/github/license/Andersseen/Strata)](./LICENSE)

Server Components and structured server APIs for Angular and Analog.

Strata makes server-side Angular a coherent application model, on two pillars:

- **Server Components** — run Angular components on the server without shipping
  their implementation or server dependencies to the browser. Only children
  marked as explicit client boundaries (`[strataClient]`) hydrate, as
  interactive islands. **Experimental:** `@strata-sc/server-components` is
  prepared for its first release on the npm `next` channel (0.x, API may change before 1.0); it is dogfooded on the official website and
  qualified in this repository on Node/Nitro and Cloudflare workerd, for
  initial/document navigation only (Angular Router SPA navigation into a new
  Server Component subtree is not supported yet). See
  [its README](./packages/server-components/README.md).
- **Controllers** — declare HTTP APIs with standard-decorator controllers
  (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`) and register them on the
  Nitro/H3 router you already own. `@strata-sc/core` and `@strata-sc/analog`
  are published as `0.x` under `next`.

Both leave Angular, Analog and Nitro in control of their runtime. Strata is
experimental, intentionally narrow, and designed in public.

## About

Strata takes its name from _stratum / strata_ — layers. The goal is a
layered server architecture for [Angular](https://angular.dev) and
[Analog](https://analogjs.org): server-rendered UI with explicit client
islands, and structured HTTP APIs, on the [Nitro](https://nitro.build) /
[H3](https://h3.dev) runtime.

**Experimental, pre-1.0, and developed in public.** Strata stays deliberately
small: a build-time server/browser graph split for Server Components, and
controller metadata with runtime adapters, without taking control of the H3 or
Nitro application you already own.

## Official website

The repository includes the official Strata landing page at
[`apps/www`](./apps/www). It is an SSR-enabled [AnalogJS](https://analogjs.org)
application built with Angular, Tailwind CSS 4,
[@voltui/components](https://volt-ui.andersseen.dev),
[Angular Movement](https://github.com/Andersseen/angular-movement), and
[Lumen Icons](https://github.com/Andersseen/lumen-icons). Its homepage
dogfoods Server Components: the "Server Components" section is a real
`@ServerComponent()` that injects a server-only repository (which imports a
further server-only module) and renders one interactive client island. It also
has a light/dark theme switcher, Server Component, controller and Analog
examples, and an explanation of Strata's runtime boundary.

`pnpm test:www:server-components` qualifies that dogfood on the site's
production builds: a plain-SSR control build, the browser/server graph split
(markers and per-chunk source modules), HTTP SSR, and the site's Playwright
suite (hydration, interaction, no Angular hydration errors) on Nitro
`node-server` and on the Cloudflare Pages build under local `wrangler pages dev`.

```bash
pnpm --filter @strata-sc/www dev
```

Create a production build with:

```bash
pnpm --filter @strata-sc/www build
```

## Dogfood demo

[`apps/relay`](./apps/relay) is a private, local-only operations console used to exercise Strata in
a realistic Analog application. It is deliberately separate from the official website and has no
deployment configuration.

Relay uses Strata controllers for an operations snapshot, service details, incident creation and
incident transitions. The flows cover route params, query strings, request bodies, headers, a
request-scoped controller factory and cleanup, while a native Analog health route remains alongside
them. Its Angular UI uses Volt UI for the dashboard, service inventory and incident workflow.

It also contains two practical Server Component examples:

- The main dashboard renders a server-only operations briefing with two independent interactive
  client boundaries and flat serialized props.
- `/release` renders a server-only release assessment plus an interactive rollout simulator. Links
  to and from this route deliberately use full document navigation, the only navigation mode the
  current experiment qualifies.

- `/incidents` renders a live incident digest from the same in-memory repository the Strata
  controllers write to, with one triage island per incident (inside `@for`) that mutates through
  `PATCH /api/ops/incidents/:id`; the next document request renders the new state. The repository
  is a process-wide singleton because Analog bundles the Angular SSR code separately from Nitro's
  server code, so a plain module-level instance would exist twice.

`pnpm relay:verify:server-components` (the same gate as `pnpm test:relay:server-components`)
checks a plain-SSR control build, the browser/server graph split (markers and per-chunk source
modules), each route's SSR, a controller write the next server render must reflect, and Relay's
Playwright suite (hydration of every island, interaction, no Angular errors).

```bash
pnpm relay:dev
```

Run its focused checks with:

```bash
pnpm relay:test
pnpm relay:build
pnpm relay:verify:server-components
pnpm relay:test:e2e
```

### Cloudflare Pages

The official site is configured for direct upload to the `strata-www`
Cloudflare Pages project. Create that project once (after authenticating
Wrangler), then use the root scripts to build, run the Pages runtime locally,
or make a production deployment:

```bash
pnpm www:pages:create
pnpm www:pages:dev
pnpm www:pages:deploy
```

`www:pages:dev` builds with the `cloudflare-pages` Nitro preset and runs the
result through `wrangler pages dev` at `http://localhost:8789`, so the local
runtime matches Pages rather than the default Node preview. GitHub Actions deploys the same artifact only
for pushes to `main` after CI passes. Add `CLOUDFLARE_API_TOKEN` (with Pages
write permission) and `CLOUDFLARE_ACCOUNT_ID` as repository secrets before
the first merged deployment.

## Installation

**Registry (experimental).** `@strata-sc/core` and `@strata-sc/analog` are published
to npm only under the `next` dist-tag (the first publish is pending). `0.x`
versions are pre-1.0 and may break:

```bash
pnpm add @strata-sc/core@next @strata-sc/analog@next
```

`@strata-sc/h3` is not published to npm yet (see
[SPEC-002](./docs/specs/002-h3-consumer-type-closure.md) and
[ADR-004](./docs/adr/004-experimental-npm-distribution.md)).

**Source (`main`).** To work on Strata itself, clone the repository and use the
pnpm workspace (`pnpm install && pnpm build`). Workspace packages are linked
with `workspace:*`. External projects should install the registry packages,
not link to a checkout.

## Releases

Releases are automated with [Changesets](./.changeset) and the
[Release](./.github/workflows/release.yml) workflow:

1. Every PR that changes a package adds a changeset (`pnpm changeset`) choosing
   `patch`, `minor` or `major` for each package it touches.
2. On merge to `main`, the workflow opens or updates a **Version Packages** PR
   with the bumped versions and CHANGELOGs.
3. Merging that PR publishes `@strata-sc/core` and `@strata-sc/analog` to npm under the
   `next` dist-tag and creates the matching git tags and GitHub Releases.

While packages are `0.x`, breaking changes are released as `minor`.
`@strata-sc/h3` is private and is not published.

See [GitHub releases](https://github.com/Andersseen/Strata/releases) and
[all tags](https://github.com/Andersseen/Strata/tags) for published history.

## Status: early development

This repository is still in early development. `@strata-sc/core` has a first
**experimental** API for declaring controllers and routes, built on standard
ECMAScript decorators, and `@strata-sc/h3` now wires that metadata into a real
[H3](https://h3.dev) app. `@strata-sc/analog` registers the same controllers inside an
[Analog](https://analogjs.org) 2 app. Everything here is **experimental and pre-1.0**. `@strata-sc/core` and
`@strata-sc/analog` are published to npm only under the experimental `next` dist-tag (first
publish pending).

```ts
import { H3 } from "h3";
import { Controller, Get } from "@strata-sc/core";
import { registerControllers } from "@strata-sc/h3";

@Controller("/users")
class UsersController {
  @Get()
  findAll() {
    return [{ id: "1" }];
  }
}

const app = new H3();

registerControllers(app, [UsersController]);
```

`@Controller` and `@Get` only build declarative metadata describing a
controller's routes. `@strata-sc/h3` is a thin adapter on top of that metadata:
it reads each controller's definition via `@strata-sc/core`'s public
`getControllerDefinition` API, registers its `@Get()` routes directly on the
H3 app you pass in, and invokes the matching controller method when H3
resolves a route. Strata does not replace H3 or own the HTTP runtime — you
still create and control the `H3` instance yourself, and any routes you
register on it directly keep working unchanged.

There is no dependency injection or controller lifecycle yet: `@strata-sc/h3`
instantiates each controller once, with `new ControllerClass()`, at
registration time. This is a deliberately minimal, provisional placeholder
until a real lifecycle/DI design lands in a later iteration — it is not a
stable API.

### Analog

Analog 2 runs on Nitro 2, which runs on H3 **v1** — a different major from the H3 v2 that
`@strata-sc/h3` targets — so Analog uses a separate, sibling adapter, `@strata-sc/analog`. It registers
controllers on the router Nitro already owns (`nitroApp.router`, part of Nitro's public plugin
API), from a Nitro server plugin. It does not depend on `@strata-sc/h3`, and it does not depend on
`h3`, `nitropack` or `@analogjs/*` either.

```ts
// src/server/strata/users.controller.ts
import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

@Controller("/api/strata/users")
export class UsersController {
  @Get()
  findAll() {
    return [{ id: "1", name: "Ada" }];
  }

  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    return { id: request.params["id"], name: "Ada" };
  }
}
```

```ts
// src/server/plugins/strata.ts
import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { UsersController } from "../strata/users.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController]);
});
```

`GET /api/strata/users` answers `200` JSON in `analog dev` and in the production server, alongside
native Analog routes.

Controllers are **request-scoped** (experimental): `registerControllers()` only reads and validates
metadata at startup, and every matching request gets a new controller instance, created with
`new UsersController()` by default. Instances are never cached, pooled or shared between requests,
so instance fields cannot leak state across users. A custom `controllerFactory` (sync or async) can
take part in creating each request's controller; it receives the controller class and the request's
`StrataAnalogRequest`, and must return an instance of that class:

```ts
const greetings = new GreetingService();

registerControllers(nitroApp.router, [GreetingController], {
  controllerFactory: (Controller) =>
    Controller === GreetingController ? new GreetingController(greetings) : new Controller(),
});
```

The factory can also release what it creates for a request (experimental). `onCleanup` registers a
callback, sync or async, that Strata runs when the controller invocation finishes, including error
paths:

```ts
registerControllers(nitroApp.router, [UsersController], {
  controllerFactory: (Controller, { onCleanup }) => {
    const resource = createResource();

    onCleanup(() => resource.dispose());

    return new Controller();
  },
});
```

Every registered cleanup runs exactly once, after the factory and the awaited handler call settle,
whether they succeed, the factory throws or rejects, or the handler throws or rejects. Cleanups run
last registered first (LIFO), each awaited before the next, and the request's response is sent only
after all of them. None of the errors is hidden: after trying every cleanup, Strata rethrows the
original error, or the single cleanup error if the invocation succeeded, and otherwise an
`AggregateError` with the original error (if any) followed by every cleanup error. Cleanup covers
the controller invocation, not a streamed response body.

The factory is an extension seam, not a DI container: Strata provides no injector. Errors it throws
or rejects with propagate to Nitro unchanged; a result that is not an instance of the controller
class fails with `StrataAnalogConfigurationError`. (`@strata-sc/h3` still creates one instance per
controller at registration.)

Angular DI works through this seam, with injectors the application owns. This is an experimental
result, not a Strata API (see [SPEC-003](./docs/specs/003-analog-request-lifecycle-angular-di.md)).
The fixture's Nitro plugin bootstraps an Angular application injector once. Its factory builds each
controller inside a per-request child injector and destroys that injector with `onCleanup`, so
controllers use ordinary `inject()`:

```ts
@Controller("/api/strata/angular-di")
export class CatalogController {
  private readonly catalog = inject(CatalogService); // application lifetime
  private readonly identity = inject(RequestIdentity); // request lifetime

  @Get("/products/:id")
  async findOne(request: StrataAnalogRequest) {
    await somethingAsync();
    return this.catalog.findProduct(request.params["id"] ?? "");
  }
}
```

Resolve dependencies at construction and keep them across `await`: calling `inject()` inside a
handler throws `NG0203`. The injectors are separate from Analog's SSR and server-function
injectors, which no supported Analog seam exposes, so `providedIn: 'root'` services are not shared
with them. The Nitro bundle also needs `@angular/compiler` in `nitro.moduleSideEffects`. See the
[feasibility report](./docs/research/analog-di-feasibility.md) for the evidence and limits.

Handlers may accept one provisional `StrataAnalogRequest`
argument for params, query, headers, URL/path, context and lazy body readers; Nitro's H3 event is
not exposed to controller code. Controllers under `src/server/**` stay out of the client bundle. The
[integration report](./docs/research/analog-integration-baseline.md) records what is verified
(Analog 2.7.2, Nitro 2.13.4) and what is not.

Nothing here should be considered stable — the API can still change in
breaking ways in any `0.x` release.

The [architecture and SDD documentation](./docs/README.md) records the current
implementation, decisions, risks and [roadmap to 1.0](./docs/ROADMAP.md).
Work runs on two tracks. **H3 consumer qualification:** packed-consumer runtime verification has
executed, but strict consumer types for `@strata-sc/h3` are upstream-blocked by H3/crossws declarations
([SPEC-002](./docs/specs/002-h3-consumer-type-closure.md)), so M1 stays blocked. **Analog
integration:** `@strata-sc/analog` has request input, per-request controllers, request cleanup and a
conditional go for Angular DI ([SPEC-003](./docs/specs/003-analog-request-lifecycle-angular-di.md)).
Strict Server Component PoCs reached a conditional go on Node and on local Cloudflare workerd, for
document navigation only; Angular Router navigation is a recorded no-go. Their mechanism lives in the
experimental `@strata-sc/server-components` package (first `next` release in preparation). Analog integration is still limited to
GET controllers on the Nitro router, and Strata will not use legacy parameter decorators.

Strata 1.0 requires production-ready **Server Components** in a real
Angular/Analog application: server implementations and dependencies excluded
from browser output, with explicit interactive Angular descendants and a
tested navigation strategy. Only an experimental, unpublished mechanism exists so far
([evidence](./docs/research/server-component-graph-poc.md)); the capability is not production-ready.
See the [1.0 release gates](./docs/RELEASE-1.0.md).

## Packages

| Package                                                        | Description                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`@strata-sc/core`](./packages/core)                           | Experimental `@Controller` / `@Get` metadata primitive.                                                              |
| [`@strata-sc/h3`](./packages/h3)                               | Experimental H3 adapter: registers Strata controllers on an H3 app.                                                  |
| [`@strata-sc/analog`](./packages/analog)                       | Experimental Analog adapter: registers Strata controllers on the Nitro router.                                       |
| [`@strata-sc/server-components`](./packages/server-components) | **Experimental (`next`).** Server Component graph split: marker, client boundary, island runtime and Vite transform. |

## Stack

- [TypeScript](https://www.typescriptlang.org/) (strict, ESM)
- [pnpm workspaces](https://pnpm.io/workspaces)
- [Turborepo](https://turborepo.com/)
- [Vite](https://vite.dev/) (library mode)
- [Vitest](https://vitest.dev/)
- [ESLint](https://eslint.org/) (flat config)
- [Prettier](https://prettier.io/)
- [Changesets](https://github.com/changesets/changesets)

The packages target Node.js >= 22. Developing this repository requires Node.js >= 22.22.3,
the floor of the Angular 22 / Analog 2.7 toolchain used by the fixture (`apps/analog-fixture`);
that requirement is not imposed on the published packages.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Community expectations are in the
[Code of Conduct](./CODE_OF_CONDUCT.md), security reports follow
[SECURITY.md](./SECURITY.md), and support routes are collected in
[SUPPORT.md](./SUPPORT.md).

## License

[MIT](./LICENSE)
