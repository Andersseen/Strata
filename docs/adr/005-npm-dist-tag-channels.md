---
type: decision
---

# ADR-005: Stable releases on `latest`, prereleases on `next`

- Status: Accepted — supersedes the dist-tag rule of
  [ADR-004](004-experimental-npm-distribution.md); the rest of ADR-004 stands
- Date: 2026-10-15
- Evidence: npm dist-tags on 2026-10-15 (`latest` → `0.1.0`, `next` → `0.2.1`/`0.2.0`),
  `pnpm release:sync-dist-tags:dry-run`, `tools/release/lib/dist-tags.test.ts`

## Context

ADR-004 published every release under `next` and never moved `latest`. npm assigns `latest` to a
package's first version, so `latest` stayed at `0.1.0` while `0.2.x` shipped on `next`. The
consequences were the opposite of the intent:

- `npm install @strata-sc/core` (no tag) installed the oldest release;
- npmjs.com showed `0.1.0` and "published 20 days ago", so the project looked unmaintained and
  releases looked broken;
- the release gates had to special-case npm's own first-release `latest` assignment.

Pre-1.0 instability is already expressed by the `0.x` version: semver ranges (`^0.2.0`) never
cross a minor in `0.x`. A dist-tag does not need to say it a second time.

## Decision

- A stable version (`x.y.z`, `0.x` included) is published on `latest`.
- A prerelease (`x.y.z-next.N`, from Changesets pre mode: `pnpm changeset pre enter next`) is
  published on `next`. `latest` is untouched.
- `next` is never left behind `latest`: after a stable release, `next` moves up to it when it
  exists and is older. `@next` therefore always installs the newest build.
- No tag ever moves backwards.
- The policy is code (`tools/release/lib/dist-tags.ts`). `release.yml` runs `changeset publish`
  (no `--tag`), then `pnpm release:sync-dist-tags`, which applies the policy idempotently with the
  existing `NPM_TOKEN` and verifies the result. The first run after this ADR promotes the
  `0.2.x` releases to `latest`.

## Consequences

- Plain installs get the current release. Docs install without a tag.
- Users who pinned `@next` keep receiving every release, stable or prerelease.
- Release candidates for 1.0 (`changeset pre enter next` → `1.0.0-next.N`) can be tried on `next`
  without affecting `latest`; `changeset pre exit` then releases `1.0.0` on `latest`.
- The registry consumer no longer asserts dist-tags; it qualifies the artifact by exact version.
  Dist-tag policy is enforced by the sync step, which fails the release workflow if it cannot
  apply it.

## Reopening trigger

A move to npm trusted publishing (dist-tag edits then need their own credential path), or a
decision to keep a separate long-lived prerelease line.
