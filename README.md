# Strata

Structured server applications for Angular and Analog, powered by H3.

## About

Strata takes its name from _stratum / strata_ — layers. The goal is a
structured, layered server framework built on top of [H3](https://h3.dev),
designed with [Angular](https://angular.dev) and
[Analog](https://analogjs.org) in mind.

## Status: early development

This repository currently contains only the **technical foundation**: the
monorepo, build tooling, linting, testing, and release infrastructure.

There is **no public API yet**. `@strata/core` exists solely to validate that
the workspace, TypeScript setup, build pipeline, and test runner work end to
end. Nothing here should be considered stable, and nothing is published to
npm yet.

A technical roadmap and the actual framework design (routing, decorators,
dependency injection, framework integrations, etc.) will follow in later
iterations.

## Packages

| Package                           | Description                            |
| --------------------------------- | -------------------------------------- |
| [`@strata/core`](./packages/core) | Foundation package, no public API yet. |

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
