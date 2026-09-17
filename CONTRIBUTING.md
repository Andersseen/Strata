# Contributing to Strata

Strata is in early development. Experimental controller/GET metadata and an
H3 adapter already exist. See the [current implementation audit](./docs/STATE.md)
and [SDD workflow](./docs/SDD.md) before starting framework work.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm test:consumer:types # SPEC-002 H3 declaration-closure experiment; no eligible candidate found
pnpm test:consumer # installed consumer qualification; currently blocked on strict H3 types
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
2. For framework work, use the single ready [implementation spec](./docs/specs/README.md).
   Keep the change within its scope; report architectural blockers before expanding it.
3. If it affects a published package, run `pnpm changeset` and describe the
   change.
4. Open a pull request with acceptance-criteria evidence and relevant compatibility
   results. CI must pass (build, lint, typecheck, test, consumer type-closure experiment, consumer
   qualification), together with the spec's checks. CI builds before type-aware lint on a fresh
   checkout; see STATE for the consumer type blocker.
   Astra reviews architectural coherence before the next spec is prepared.

## Code style

Formatting is enforced by Prettier and linting by ESLint — run `pnpm format`
and `pnpm lint` before opening a PR. Please keep changes focused and avoid
introducing packages or APIs outside the accepted spec. Architectural constraints
and open decisions are documented in [docs/](./docs/README.md). Astra maintains
architecture and specs; implementation agents own code and tests.

Authored executable source and tooling should use TypeScript. Generated JavaScript must not be
committed as maintained source.
