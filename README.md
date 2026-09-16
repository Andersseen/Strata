# Strata

Structured server applications for Angular and Analog, powered by H3.

## About

Strata takes its name from _stratum / strata_ — layers. The goal is a
structured, layered server framework built on top of [H3](https://h3.dev),
designed with [Angular](https://angular.dev) and
[Analog](https://analogjs.org) in mind.

## Status: early development

This repository is still in early development. `@strata/core` now has a
first **experimental** API for declaring controllers and routes, built on
standard ECMAScript decorators — but there is no HTTP runtime yet, nothing
is wired up to H3, and nothing is published to npm.

```ts
import { Controller, Get } from "@strata/core";

@Controller("/users")
class UsersController {
  @Get()
  findAll() {
    return [];
  }
}
```

`@Controller` and `@Get` only build declarative metadata describing a
controller's routes; a future `@strata/h3` adapter will be responsible for
turning that metadata into an actual running server. Nothing here should be
considered stable — the API can still change in breaking ways before it's
published.

A technical roadmap and the rest of the framework design (more HTTP methods,
parameter decorators, dependency injection, framework integrations, etc.)
will follow in later iterations.

## Packages

| Package                           | Description                                             |
| --------------------------------- | ------------------------------------------------------- |
| [`@strata/core`](./packages/core) | Experimental `@Controller` / `@Get` metadata primitive. |

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
