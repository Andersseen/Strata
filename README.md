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
[H3](https://h3.dev) app — but nothing here is published to npm yet.

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

Nothing here should be considered stable — the API can still change in
breaking ways before it's published.

The [architecture and SDD documentation](./docs/README.md) records the current
implementation, decisions, risks and [roadmap to 1.0](./docs/ROADMAP.md).
The next slice is [packed consumer compilation verification](./docs/specs/001-packed-consumer-compilation.md).
Request-input APIs, Angular DI and Analog integration still require design
and experimental evidence; Strata will not use legacy parameter decorators.

Strata 1.0 requires production-ready **Server Components** in a real
Angular/Analog application: server implementations and dependencies excluded
from browser output, with explicit interactive Angular descendants and a
tested navigation strategy. This capability is not implemented yet. See the
[1.0 release gates](./docs/RELEASE-1.0.md).

## Packages

| Package                           | Description                                                         |
| --------------------------------- | ------------------------------------------------------------------- |
| [`@strata/core`](./packages/core) | Experimental `@Controller` / `@Get` metadata primitive.             |
| [`@strata/h3`](./packages/h3)     | Experimental H3 adapter: registers Strata controllers on an H3 app. |

## Stack

- [TypeScript](https://www.typescriptlang.org/) (strict, ESM)
- [pnpm workspaces](https://pnpm.io/workspaces)
- [Turborepo](https://turborepo.com/)
- [Vite](https://vite.dev/) (library mode)
- [Vitest](https://vitest.dev/)
- [ESLint](https://eslint.org/) (flat config)
- [Prettier](https://prettier.io/)
- [Changesets](https://github.com/changesets/changesets)

Requires Node.js >= 22.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
