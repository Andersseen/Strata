# ADR-004: Experimental npm distribution of core and analog under `next`

- Status: Accepted — distribution boundary only; no API or stability change
- Date: 2026-09-25
- Evidence: `pnpm test:package-consumer`, `pnpm release:packages:dry-run`,
  [publish workflow](../../.github/workflows/publish-packages.yml)

## Context

A real external repository (ForgeCMS: Node 22, TypeScript 5.9.2, Angular 21.2, Analog 2.5, H3 1.15)
needs to install Strata from a registry, not through `link:`, `file:` or source aliases. Until now
every package was `0.0.0`, and `release.yml` only created GitHub Releases from `v*` tags.

`@strata/h3` has a documented consumer type-closure blocker in H3 v2/crossws declarations
([SPEC-002](../specs/002-h3-consumer-type-closure.md)). `@strata/analog` types the Nitro router
structurally and exposes no H3/Nitro types.

## Decision

- Changesets stays the source of package versions. The pending changesets set the first versions:
  `@strata/core` 0.1.0, `@strata/analog` 0.1.0 and `@strata/h3` 0.1.0. `0.x` signals pre-1.0;
  package versions carry no `-alpha` suffix.
- Only `@strata/core` and `@strata/analog` are published. `@strata/h3` is versioned but excluded
  from the registry until its blocker is resolved or explicitly accepted. The allowlist lives in
  `tools/release/lib/packages.ts` and fails if it ever includes `@strata/h3`.
- Releases use the `next` dist-tag, never `latest`. Install with
  `pnpm add @strata/core@next @strata/analog@next`.
- Publishing is a separate, manual workflow (`publish-packages.yml`, `workflow_dispatch`, `main`
  only, dry-run by default). It gates on build, lint, typecheck, test, `test:analog` and
  `test:package-consumer`, then publishes the exact tarballs it inspected. It never runs on pull
  requests, pushes or tags.
- Before publishing, the workflow verifies that the npm identity is the `strata` user or a member
  of the `strata` org. A package being absent from the registry does not prove scope ownership.
  Package names are not changed if that check fails.
- Auth: `NPM_TOKEN` from GitHub Secrets for the first publish, with `--provenance`
  (`id-token: write`). Once the packages exist, switch to npm trusted publishing and remove the
  token.
- A GitHub Release (`release.yml`, `v*` tags) is not an npm publication, and repository tags
  (`v0.1.0-alpha.*`) are not package versions.

## Consequences

The packed-package consumer compiles consumer-authored `@Controller`/`@Get` controllers with
TypeScript 5.9.2 (standard decorators, strict, `skipLibCheck: false`) and runs them on an H3 v1
router. That qualifies the boundary Strata owns, not a full Angular 21/Analog 2.5 application. The
first publish of a new npm package may also set `latest`, because npm requires one; the docs only
advertise `@next`.

## Reopening trigger

Resolution or acceptance of the `@strata/h3` blocker, a move to trusted publishing, or promotion
of any package to `latest`.
