# Contributing to Strata

Strata is in early development. The project is currently just its technical
foundation — no framework features exist yet, so the most useful
contributions right now are around tooling, CI, and infrastructure.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

Other useful scripts:

```bash
pnpm dev          # run packages in watch mode
pnpm test:watch   # run tests in watch mode
pnpm format       # format the repo with Prettier
pnpm format:check # check formatting without writing
pnpm changeset     # record a changeset for your change
```

## Workflow

1. Create a branch from `main`.
2. Make your change.
3. If it affects a published package, run `pnpm changeset` and describe the
   change.
4. Open a pull request. CI must pass (lint, typecheck, test, build).

## Code style

Formatting is enforced by Prettier and linting by ESLint — run `pnpm format`
and `pnpm lint` before opening a PR. Please keep changes focused and avoid
introducing new packages or APIs without discussing them first, since the
project's architecture hasn't been decided yet.
