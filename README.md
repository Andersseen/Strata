# Strata

Structured server applications for Angular and Analog, powered by H3.

## About

Strata takes its name from _stratum / strata_ — layers. The goal is a
structured, layered server framework built on top of [H3](https://h3.dev),
designed with [Angular](https://angular.dev) and
[Analog](https://analogjs.org) in mind.

## Status: early development

This repository is still in early development. `@strata/core` has a first
**experimental** API for declaring controllers and routes, built on standard
ECMAScript decorators, and `@strata/h3` now wires that metadata into a real
[H3](https://h3.dev) app. `@strata/analog` registers the same controllers inside an
[Analog](https://analogjs.org) 2 app. Everything here is **experimental and pre-1.0**, and nothing is
published to npm yet.

```ts
import { H3 } from "h3";
import { Controller, Get } from "@strata/core";
import { registerControllers } from "@strata/h3";

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
controller's routes. `@strata/h3` is a thin adapter on top of that metadata:
it reads each controller's definition via `@strata/core`'s public
`getControllerDefinition` API, registers its `@Get()` routes directly on the
H3 app you pass in, and invokes the matching controller method when H3
resolves a route. Strata does not replace H3 or own the HTTP runtime — you
still create and control the `H3` instance yourself, and any routes you
register on it directly keep working unchanged.

There is no dependency injection or controller lifecycle yet: `@strata/h3`
instantiates each controller once, with `new ControllerClass()`, at
registration time. This is a deliberately minimal, provisional placeholder
until a real lifecycle/DI design lands in a later iteration — it is not a
stable API.

### Analog

Analog 2 runs on Nitro 2, which runs on H3 **v1** — a different major from the H3 v2 that
`@strata/h3` targets — so Analog uses a separate, sibling adapter, `@strata/analog`. It registers
controllers on the router Nitro already owns (`nitroApp.router`, part of Nitro's public plugin
API), from a Nitro server plugin. It does not depend on `@strata/h3`, and it does not depend on
`h3`, `nitropack` or `@analogjs/*` either.

```ts
// src/server/strata/users.controller.ts
import { Controller, Get } from "@strata/core";

@Controller("/api/strata/users")
export class UsersController {
  @Get()
  findAll() {
    return [{ id: "1", name: "Ada" }];
  }
}
```

```ts
// src/server/plugins/strata.ts
import { registerControllers } from "@strata/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { UsersController } from "../strata/users.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController]);
});
```

`GET /api/strata/users` answers `200` JSON in `analog dev` and in the production server, alongside
native Analog routes. As with `@strata/h3`, the lifecycle is provisional: one instance per
controller, created at registration, and handlers take no arguments. Controllers under
`src/server/**` stay out of the client bundle. The
[integration report](./docs/research/analog-integration-baseline.md) records what is verified
(Analog 2.7.2, Nitro 2.13.4) and what is not.

Nothing here should be considered stable — the API can still change in
breaking ways before it's published.

The [architecture and SDD documentation](./docs/README.md) records the current
implementation, decisions, risks and [roadmap to 1.0](./docs/ROADMAP.md).
Packed consumer runtime verification has executed; strict H3 declaration compatibility still blocks M1.
The next slice is [H3 consumer type closure](./docs/specs/002-h3-consumer-type-closure.md).
Request-input APIs and Angular DI still require design and experimental evidence, and Analog
integration is limited to registering GET controllers on the Nitro router; Strata will not use
legacy parameter decorators.

Strata 1.0 requires production-ready **Server Components** in a real
Angular/Analog application: server implementations and dependencies excluded
from browser output, with explicit interactive Angular descendants and a
tested navigation strategy. This capability is not implemented yet. See the
[1.0 release gates](./docs/RELEASE-1.0.md).

## Packages

| Package                               | Description                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| [`@strata/core`](./packages/core)     | Experimental `@Controller` / `@Get` metadata primitive.                        |
| [`@strata/h3`](./packages/h3)         | Experimental H3 adapter: registers Strata controllers on an H3 app.            |
| [`@strata/analog`](./packages/analog) | Experimental Analog adapter: registers Strata controllers on the Nitro router. |

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

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
