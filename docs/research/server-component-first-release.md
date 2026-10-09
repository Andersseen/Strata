# Server Components: first experimental release preparation

Baseline: `main` at `4113b0224d2dc828199c8a7ac726af6d911b3960` (PR #53 merged). Branch
`feat/server-components-first-release`.

**First experimental release preparation: GO.** No package, layout or release-workflow blocker
remains. This is not a claim that Strata 1.0 is ready, nor that the package is stable.

## Why the package is ready for experimental publication

- The private tarball qualification is GO on every axis
  ([report](server-component-package-consumer.md)): tarball integrity, declaration portability
  (TypeScript 5.9.2, 6.0.3), external install, Node production consumer, external dev server,
  Cloudflare/workerd, graph confidentiality.
- That gate was re-run on this branch and, on a disposable copy after `changeset version`, against the
  actual `0.1.0` artifact: both PASS, 0 failing checks.
- "Public" is explicitly not "stable": the README, the changeset and the website state `0.x`, the
  `next` channel and that API/semantics may change before 1.0.

## Manifest changes (`packages/server-components/package.json`)

- Removed `"private": true`. `"version"` stays `0.0.0`: Changesets is the only owner of the bump.
- Public experimental description; `author`, `homepage`, `repository` (directory
  `packages/server-components`), `bugs` and eight real keywords, consistent with core/analog.
- `publishConfig: { "access": "public" }` and **no** `tag`: `changeset publish --tag next` in
  `release.yml` stays the single source of truth for the dist-tag.
- Exports unchanged (`.`, `./vite`, `./server-only`).

## Peer-range decision

| Peer                                 | Before               | After        | Why                                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@angular/core`, `@angular/compiler` | `^22.0.0`            | `^22.1.7`    | The hydration path (hydrating a root onto an `ngh` host) is undocumented Angular behaviour and has only ever run on 22.1.7. 22.0.x was never qualified.                                                                                                 |
| `vite`                               | `^8.0.0`             | `>=8.3.0 <9` | The dev integration (environment-aware `hotUpdate`, per-environment module graphs) and the whole external consumer run on Vite 8.3.0. The repo's own lockfile resolves 8.3.0 for every workspace consumer (8.1.5 appears only inside `@angular/build`). |
| `typescript`                         | `^5.9.0 \|\| ^6.0.0` | unchanged    | Direct declaration evidence at 5.9.2 and 6.0.3.                                                                                                                                                                                                         |

The lower bounds equal the versions the external consumer pins (Angular 22.1.7, Vite 8.3.0), so the
narrowed range is exactly what that gate covers. Nothing was broadened. `devDependencies` and the
lockfile are unchanged (`pnpm install --frozen-lockfile` is a no-op).

## Release tooling changes

- `tools/release/lib/packages.ts`: `PUBLISHABLE_PACKAGES` is split into `REGISTRY_PACKAGES` (core,
  analog, server-components) and `CONTROLLER_PACKAGE_CONSUMER_PACKAGES` (core, analog).
  `EXCLUDED_PACKAGES` is now only `@strata-sc/h3`.
- `tools/package-consumer/run.ts` uses the controller subset, so `test:package-consumer` is still a
  controllers/Analog consumer and does not install Server Components.
- Tarball inspection is now `inspectPackedPackage(manifest, files)`, a pure function that derives
  validity from the manifest: required `package.json`/`README.md`/`LICENSE`; `main`, `types` and every
  `exports` target present; nothing outside `dist/` and root metadata (CHANGELOG allowed); no
  `src/`, tests, `tsconfig*`, `vite.config*`; no `workspace:`/`link:`/`file:`/`portal:` ranges; no
  excluded dependency; released (non-private, non-`0.0.0`) version. No package name is special-cased
  and no `dist/index.js` is assumed.
- Tests (`pnpm test:release`, also run by `pnpm test`; 18 tests): classic layout passes; the
  Server Components layout (`fesm2022`, `vite.js`, `server-only.js`) passes; broken export target
  (types and default), missing LICENSE/README, shipped source/test/config files, private/`0.0.0`,
  workspace ranges and excluded dependencies fail; selection = core, analog, server-components with
  h3 excluded; `DIST_TAG` is `next` and never `latest`; the `publishedPackages` parser.
- `test:server-component-package-consumer` no longer asserts `private: true`; it asserts the package
  is public, registry-eligible, selected and h3 still excluded, and packs whatever version is current
  (`0.0.0` is not a failure of that gate). Shared fixture constants moved to
  `tools/server-components/lib/consumer-fixture.ts`.
- The package-boundary unit test now asserts public + `publishConfig: { access: "public" }` instead of
  private.
- `publish-packages.ts` comments describe three packages, the `next` tag, h3 excluded, and that it is
  the dry-run rehearsal of the Changesets release.

## Changeset

`.changeset/server-components-first-experimental-release.md`: `"@strata-sc/server-components": minor`,
a concise release-level summary. Not consumed on this branch; no `CHANGELOG.md` committed.

`pnpm changeset status`: `@strata-sc/server-components` `0.0.0 → 0.1.0` (minor); `@strata-sc/core` and
`@strata-sc/analog` are not in the release list.

## Temporary Version Packages simulation

In a throwaway `git worktree` outside the repository (deleted afterwards, nothing copied back):

- `pnpm changeset version`: server-components `0.1.0`, `CHANGELOG.md` created with the summary,
  changeset file deleted, core and analog still `0.2.1`.
- `pnpm build`, then `pnpm release:packages:dry-run`: core and analog `0.2.1` already on the registry
  (skipped); `@strata-sc/server-components@0.1.0` passes inspection (0 problems), 73.0 kB packed
  (npm: 74.7 kB, 33 files, `strata-sc-server-components-0.1.0.tgz`) and `npm publish --dry-run`
  reports "Publishing to https://registry.npmjs.org/ with tag next and public access (dry-run)".
  The npm scope preflight warned (`E401`, no auth) as accepted for a dry-run.
- `pnpm test:server-component-package-consumer` against that `0.1.0` tarball: PASS, 0 failing checks
  (stronger than the requested install/resolve/build/SSR/hydration smoke): the CHANGELOG/version
  metadata did not alter the artifact.

## Release workflow and registry post-publish verification

`release.yml`: `changesets/action@v2` stays the orchestrator (`pnpm changeset publish --tag next`),
now with `id: changesets`; `id-token: write` and `NPM_CONFIG_PROVENANCE: "true"` are unchanged. Two
steps follow, guarded by
`published == 'true' && contains(fromJSON(publishedPackages).*.name, '@strata-sc/server-components')`,
so unrelated core/analog releases skip them: install Chromium, then
`pnpm test:server-component-registry-consumer` with `STRATA_PUBLISHED_PACKAGES` from the action.

`tools/server-components/registry-consumer.ts`:

1. Exact version from `STRATA_SC_REGISTRY_VERSION` or the `publishedPackages` JSON (no hardcoded
   version, no `@next` ambiguity).
2. Bounded polling of `npm view <pkg>@<version> version` (24 attempts × 10 s maximum).
3. Records `dist.integrity` (must be `sha512-…`) and `dist.tarball` (must be on registry.npmjs.org).
4. `dist-tags`: `next` must equal the version; `latest` is only read, and must not equal it.
5. Fresh OS-temp copy of the consumer fixture, plain `npm install` of the exact version with an empty
   npm user config; asserts installed `package.json` version, real directory (not a symlink), all
   three entries resolve under the consumer's `node_modules`, nothing from the repository.
6. `npm audit signatures` (npm's documented registry signature/provenance check) is recorded; only an
   explicit "invalid signature/attestation" report fails the gate.
7. Production build, graph split with positive controls, SSR, protocol v1, hydration by DOM identity,
   one interaction, and a direct server-only import that must fail the build with the plugin's
   diagnostic.

Not duplicated after publication: TypeScript 5.9/6 declarations, dev server and Cloudflare/workerd;
those stay in the tarball gate, which qualifies the identical artifact beforehand. On any failure the
workflow fails visibly; it never unpublishes, moves a dist-tag or republishes: a human decides.
Locally verified: argument validation (exit 2) and the not-visible failure path (`9.9.9`). The success
path can only run after a real publish.

## Docs and website

- Package README: header is "Experimental" (0.x, `next`, API may change before 1.0), install
  `pnpm add @strata-sc/server-components@next`, Quick Start (plugin before `analog()`, default
  `enabled`, generated directory in tsconfig and gitignored, `tslib` caveat, `ngServerMode` only for
  `@defer` apps), a first example of `@ServerComponent` + server-only repository + `[strataClient]`,
  a limitations table up front, and a Compatibility section naming the exact qualified tuple.
- Website Server Components section: "Experimental, on the `next` channel" and honest limitations
  instead of "not released yet" (the `test:www:server-components` expectation was updated).
- Root README/CONTRIBUTING, `docs/STATE.md` (first release prepared, expected `0.1.0`, `next`,
  registry verification pending publication) and `docs/RELEASE-1.0.md` (the "Published candidate
  installs cleanly" criterion stays **unchecked** until the registry gate succeeds).

## Remaining product limitations

Angular Router navigation into a new Server Component subtree: unsupported (silent empty surrogate).
Streaming SSR: unsupported. Package components as `[strataClient]`, `NgComponentOutlet`/dynamic
`createComponent`: unsupported. Content projection into islands: not qualified. No request-scoped
Server Component context. Separate SSR/Nitro bundles evaluate module-level state twice. Relies on
undocumented Angular hydration behaviour. Local workerd only; no deployed environment.

## Not run

`npm publish`, `pnpm publish`, `changeset publish`, `wrangler pages deploy`, the GitHub release
workflow and the registry consumer's success path (needs a published package).

## Verdict

First experimental release preparation: **GO**.

## Publication and registry evidence

Everything above describes the state before publication and stays as written. This section records
what happened afterwards. The automation problem below was a **release-verification bug, not a
publication failure**: the package was published correctly.

| Step                          | Result                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #55                        | Version Packages: `@strata-sc/server-components` `0.0.0` → `0.1.0` (merge commit `ee38035`, which is also the target of the git tag).                                                             |
| Release run 37791376843       | Changesets published `@strata-sc/server-components@0.1.0` under `next` with provenance. Package publication succeeded.                                                                            |
| Post-publish registry check   | Did not run: `fromJSON(steps.changesets.outputs.publishedPackages)` received an empty string (changesets 3 prints no "New tag:" lines), so the Playwright/registry-consumer steps never executed. |
| PR #56                        | Re-keyed the trigger on the registry: a pre-publish step checks whether the current version is absent from npm.                                                                                   |
| Release run 37826890462       | Green. The registry verification was skipped, correctly under the new logic, because `0.1.0` was already on npm.                                                                                  |
| Registry backfill (this PR)   | The exact `0.1.0` npm consumer, run locally and by the new workflow on the PR. See below.                                                                                                         |
| Rerunnable workflow (this PR) | `.github/workflows/server-component-registry.yml` ("Verify published Server Components"): `contents: read`, no secrets, `workflow_dispatch` plus relevant PR paths.                               |

### Registry facts (read-only queries)

- `npm view @strata-sc/server-components@0.1.0 version` → `0.1.0`.
- dist-tags: `{"latest":"0.1.0","next":"0.1.0"}`.
- `dist.integrity`: `sha512-ZdCw/Bkm0+vBlSUDfHOEPxthSX9JkcA99fcJGp3tlTtJvmBjrcMf82etLnAlG6kTRD0FOxFPx/wCgNcazg4eXQ==`.
- `dist.tarball`: `https://registry.npmjs.org/@strata-sc/server-components/-/server-components-0.1.0.tgz`
  (33 files); npm records a SLSA provenance attestation.
- Versions on the registry: `0.0.0-stage` (published 2026-10-08T14:19:44Z, a name placeholder) and
  `0.1.0` (14:20:41Z).
- Git tag `@strata-sc/server-components@0.1.0` → `ee38035159ecc594ea776b48593e008e53b06b88`; a GitHub
  Release for the tag **exists**. Nothing was created or moved.

### The `latest` finding

The first run of the unmodified gate against `0.1.0` passed every check except one: "`latest` was not
moved by this release". `latest` **is** `0.1.0`. npm assigns `latest` to a package when it has no
`latest` tag, so the package's first real release (published with `--tag next`) received it; no one
moved it. This was a wrong assumption in the harness, not a package defect, and no dist-tag was
touched. The check is now `latestTagVerdict` (`tools/release/lib/registry-version.ts`, unit-tested):
`latest === version` is accepted only when every other version on the registry is a `0.0.0-*`
placeholder, so a later release (`0.1.1`, ...) that moves `latest` still fails. Consumer-facing effect:
a bare `pnpm add @strata-sc/server-components` installs `0.1.0`; `@next` remains the documented channel.

### Exact-version registry consumer

Baseline (unmodified gate, `STRATA_SC_REGISTRY_VERSION=0.1.0`): all checks passed except the `latest`
check above. After the fix: **PASS, 0 failing checks**: version visible, integrity `sha512-`, tarball on
registry.npmjs.org, `next → 0.1.0`; fresh OS-temp consumer, plain `npm install` of exactly `0.1.0`; a
real directory (not a symlink) under `consumer/node_modules`; `.`, `/vite` and `/server-only` resolve
under `consumer/node_modules`, never the repository; Node production build; implementation, server-only
repository and transitive helper present in the server output only, client island in the browser
graph; `GET /product` 200 `text/html` with server-rendered content and no server marker; protocol v1
plus an `ngh` annotation; island hydrated, SSR DOM reused; `Count: 0` → one click → `Count: 1`; no
console errors; no loaded script carries a server marker; a direct server-only import in a client
module fails the production build with `[strata] Server-only module entered the browser graph` and no
marker. `npm audit signatures`: 546 packages with verified registry signatures, 149 with verified
attestations, no invalid signature or attestation.

### Rerunnable workflow

Version resolution: an explicit `version` input must be an exact semver (`0.1.0`, `0.2.0-beta.1`);
`next`, `latest`, ranges and `*` are rejected. With no input it reads
`packages/server-components/package.json`. If `npm view <pkg>@<version>` answers E404 the job writes
"Version X is not on npm yet; registry qualification is not applicable." and skips Chromium and the
gate, so a Version Packages PR with an unpublished version does not fail. Any other `npm view` error
fails. The gate is the same `tools/server-components/registry-consumer.ts` that `release.yml` runs;
`release.yml` is unchanged.

### Verdicts

| Item                               | Verdict                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| npm publication                    | **GO**                                                                                                                                                                                           |
| `0.1.0` registry artifact          | **GO** (exact-version consumer passes)                                                                                                                                                           |
| Original post-publish verification | **NO-GO** (never ran)                                                                                                                                                                            |
| PR #56 future publish trigger      | **CONDITIONAL GO**: logically qualified, but no publish has yet exercised "unpublished before publish → publish → registry consumer"; the first real next release (`0.1.1`/`0.2.0`) is the proof |
| Rerunnable registry verification   | **GO**                                                                                                                                                                                           |
| Overall first public release       | **GO**; the open item is the deployed-environment qualification, not the registry artifact                                                                                                       |
