# Server Component packed-package consumer qualification

Date: 2026-10-08. Baseline: `main` at `e17731d8` (PR #52 merged).
Question: can the actual packed `@strata-sc/server-components` be installed and used by a real Analog
application completely outside the Strata workspace?

Command: `pnpm test:server-component-package-consumer` (CI step "Server Component packed-package
consumer"). Runner: `tools/server-components/package-consumer.ts`, helpers
`tools/server-components/lib/package-consumer.ts`. Consumer template (NOT in `pnpm-workspace.yaml`):
`tests/server-component-package-consumer/fixture/`.

The package stays `@strata-sc/server-components@0.0.0`, `private: true`, in `EXCLUDED_PACKAGES`, not in
`PUBLISHABLE_PACKAGES`. Nothing is published, versioned or added to the release workflow. No Changeset
(the package is private; see "Packaging fixes" for why that is still the right call).

## Method

```
pnpm --filter @strata-sc/server-components build
pnpm pack                                   (accepts a private package; manifest untouched)
        │  strata-sc-server-components-0.0.0.tgz  — the only connection
        ▼
$TMPDIR/strata-server-component-consumer-XXXX/consumer     (outside the repository)
npm install --no-audit --no-fund --loglevel=error           (empty npm user/global config;
        │                                                    npm_*, pnpm_*, NODE_PATH, NODE_OPTIONS removed)
        ▼
real Analog app: file routing, provideClientHydration(), Angular SSR, strataServerComponents()
```

Every command of the consumer runs the consumer's own `node_modules` binaries (`vite`, `tsc`,
`wrangler`). The runner only drives Chromium (the repository's Playwright 1.62.1) from outside.

## Tarball

`strata-sc-server-components-0.0.0.tgz`, **72,222 bytes (70.5 kB)** packed, 33 files:

```
package.json  README.md  LICENSE
dist/fesm2022/{index,server-component,client-boundary,islands,boundary-protocol,hydration-plan}.{js,d.ts}
dist/fesm2022/*.js.map      (sources inlined)
dist/vite.js  dist/vite.js.map  dist/vite/{index,plugin,analyze,diagnostics,graph,module-id,server-only,surrogate}.d.ts
dist/server-only.js  dist/server-only/index.d.ts
```

Export map (`./package.json` excluded): every entry has a `types` and a `default` target and every target
is in the tarball.

| Subpath         | types                         | default                  |
| --------------- | ----------------------------- | ------------------------ |
| `.`             | `dist/fesm2022/index.d.ts`    | `dist/fesm2022/index.js` |
| `./vite`        | `dist/vite/index.d.ts`        | `dist/vite.js`           |
| `./server-only` | `dist/server-only/index.d.ts` | `dist/server-only.js`    |

Asserted: no `src/`, `*.test.*`, `vite.config.*`, `tsconfig*.json`, `apps/`, `tools/`, `.git/`,
`node_modules/`; nothing outside `dist/` except `package.json`, `README.md`, `LICENSE`; no
`workspace:`/`link:`/`portal:`/`file:` range in `dependencies`/`peerDependencies`/
`optionalDependencies`; no absolute repository, home or temp path in any `.js`, `.d.ts`, `.map`.
The generic release inspector (`tools/release/lib/packages.ts`) assumes `dist/index.js` and was left
alone; the runner has its own layout-aware inspector.

The runtime is Angular **partial-compiled** (`ɵɵngDeclare*` in `client-boundary.js` and `islands.js`) and
stays that way.

### Dependency and peer closure (emitted JavaScript)

| Specifier              | Class                                  | Where                                   |
| ---------------------- | -------------------------------------- | --------------------------------------- |
| `@angular/core`        | declared peer                          | `fesm2022/{client-boundary,islands}.js` |
| `@angular/compiler`    | declared peer                          | `vite.js` (template parsing)            |
| `typescript`           | declared peer                          | `vite.js`                               |
| `vite`                 | declared peer (types only, in `.d.ts`) | `vite/plugin.d.ts`                      |
| `node:fs`, `node:path` | Node built-ins                         | `vite.js`                               |
| `tslib`                | **not imported** (nothing to declare)  | —                                       |

No dependencies; four peers, each used. The peers are **evidence-backed and not broadened**:
`@angular/core ^22.0.0`, `@angular/compiler ^22.0.0`, `typescript ^5.9.0 || ^6.0.0`, `vite ^8.0.0`. Tested
points: Angular 22.1.7, TypeScript 6.0.3 and 5.9.2 (declarations), Vite 8.3.0. Nothing was run on
Angular 22.0.x/22.2.x or Vite 8.0–8.2, so a follow-up could narrow them (for example `@angular/core
^22.1.0`) rather than widen.

## External consumer tuple (installed, not ranges)

Node 22.23.0; `@angular/core`, `common`, `compiler`, `router`, `platform-browser`, `platform-server`
22.1.7; `@angular/compiler-cli` 22.1.7; `@angular/build` 22.1.8; `@analogjs/platform`, `router`,
`vite-plugin-angular` 2.7.2; `@analogjs/vite-plugin-nitro` 2.8.0; nitropack 2.13.4; Vite 8.3.0;
TypeScript 6.0.3; rxjs 7.8.2; tslib 2.8.1; Wrangler 4.135.0 (declared by the consumer, run from
`consumer/node_modules`); Playwright 1.62.1 (runner side). The consumer pins direct dependencies exactly.
It uses a uniform Angular 22.1.7 (the workspace fixture mixes 22.1.7 core with 22.2.1 platform
packages); this is a tested tuple, not an upgrade.

## Install integrity

- `consumer/node_modules/@strata-sc/server-components` is a real directory (no symlink, junction or
  portal) holding exactly the tarball's files; exactly one copy exists in the tree; it is the only
  `@strata-sc` package (no `core`, `analog`, `h3`).
- Resolution with Node's ESM resolver from the consumer:
  - `.` → `consumer/node_modules/@strata-sc/server-components/dist/fesm2022/index.js`
  - `/vite` → `.../dist/vite.js`
  - `/server-only` → `.../dist/server-only.js`

  Zero resolutions into the repository.

- Resolved from the installed package itself, `@angular/core`, `@angular/compiler`, `vite` and
  `typescript` all come from `consumer/node_modules`. One copy of `@angular/core`, `@angular/compiler`,
  `typescript`; one top-level `vite` (`@angular/build` keeps its own nested Vite, unrelated to the
  package).
- `npm ls --all`: no `UNMET`, no problem for any Strata, Angular, Analog, Vite, TypeScript, Nitro or
  Wrangler package. Eight ecosystem problems remain, all `sharp@0.35.4`'s wasm optional dependencies
  (`extraneous @emnapi/*`, `@img/sharp-wasm32`, `@napi-rs/*`, `@tybys/*`, and `invalid sharp`), pulled
  by Analog/Nitro tooling and unrelated to Strata.

## Declaration portability

`strict`, `skipLibCheck: false`, `moduleResolution: Bundler`, DOM lib, `experimentalDecorators`. The
consumer-authored `src/check/declarations.ts` imports `ServerComponent`, `StrataClientBoundary`,
`StrataIslandHost`, `provideClientReferences`, `ClientBoundaryProps`, `strataServerComponents` and the
server-only assertion from the installed package.

| Compiler                                               | Files | From the installed package | Diagnostics |
| ------------------------------------------------------ | ----- | -------------------------- | ----------- |
| TypeScript 6.0.3 (Analog consumer)                     | 463   | 7                          | 0           |
| TypeScript 5.9.2 (second isolated consumer, no Analog) | 424   | 7                          | 0           |

`--listFiles` shows every Strata declaration under `node_modules/@strata-sc/server-components/dist` and
none from the repository or any package `src/`.

## What the consumer proves

Consumer-authored: `ProductDetailsServerComponent` (`@ServerComponent()`), `ProductRepository` and a
transitive helper (both `import "@strata-sc/server-components/server-only"`), `AddToCartComponent`
(`signal()`, `input.required()`, a real button), pages `/`, `/product`, `/about`.

| Area                                                   | Result                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production build (`vite build`, consumer's Vite)       | passes; surrogates generated in the **external** app's `src/generated/server-components`; they import `@strata-sc/server-components`, never a path                                                                                                                                                                                                                                   |
| Browser graph                                          | `EXTERNAL_CONSUMER_{SERVER,TRANSITIVE,IMPLEMENTATION}_MARKER` absent from every file; `…_CLIENT_MARKER` present; no `@angular/compiler`, TypeScript API, plugin source, `node:fs`/`node:path`                                                                                                                                                                                        |
| Source maps (hidden)                                   | 708 browser sources: none of the three consumer server files (the generated surrogate of the Server Component is the only same-named entry), the island and the surrogate present; the runtime resolves to `node_modules/@strata-sc/server-components/dist/fesm2022/`                                                                                                                |
| Node server graph (positive)                           | all three server markers present, and the server files in the SSR maps                                                                                                                                                                                                                                                                                                               |
| SSR                                                    | 200; server content, server-computed `data-evidence`, boundary `data-strata-protocol="1"` with `ngh`; no server marker in the HTML; no JIT message in the server log                                                                                                                                                                                                                 |
| Hydration / interaction                                | SSR nodes reused (article, heading, button, count text), no leftover `ngh`, one island, `Count: 0 → Count: 1` on one click, no console error or warning                                                                                                                                                                                                                              |
| Document navigation                                    | direct URL; `/` → `/product` is a real document request (new realm); `/product` → `/about` → Back re-enters and re-hydrates from a fresh state; one island, one click one effect. Router navigation into a Server Component stays NO-GO and is not attempted                                                                                                                         |
| Firewall (installed plugin)                            | direct import, `import()` and `?raw` of `ProductRepository` from the client island each fail the production build with the plugin's `[strata] Server-only module entered the browser graph` diagnostic: consumer module, importer, reason, fix; no repository or absolute path; no marker printed; sources restored byte for byte and the next build splits correctly                |
| `vite` dev                                             | SSR, hydration, click; no JIT/compiler error and no missing-source-map warning; one server-owned edit (`External server A → B`) makes the browser request a new document, SSR shows B and not A, the realm sentinel is gone, one island, `Count: 0` again, one click one effect, `[strata] graph refreshed` and `reloading the document` in the dev log; the edited file is restored |
| Cloudflare Pages build + workerd (consumer's Wrangler) | preset `cloudflare-pages`; all three server markers in the Worker graph (7 reachable modules) and absent from the public assets; SSR, protocol v1, hydration by DOM identity and one click on workerd; no code-generation or JIT error                                                                                                                                               |

Timing on the development machine (after a warm npm cache): package build 1.4 s, `npm install` of the
Analog consumer 8–33 s, `vite build` 5–7 s, Cloudflare build 6–7 s, dev server ready in 2.3 s.

## Known consumer configuration

Documented in the README ("Consumer setup (preview)"):

1. `strataServerComponents({ root, sourceDir, generatedDir })` **before** `analog()`.
2. `ssr.noExternal: ["tslib"]` — `@ServerComponent()` makes TypeScript emit `__decorate` through
   `importHelpers`; Nitro would trace only `tslib.es6.mjs` while Node resolves `modules/index.js`. This is
   Analog/Nitro behaviour, not the package's, and depends on the app's own tsconfig, so the plugin does not
   inject it.
3. `ngServerMode` (`environments.ssr.define`) **only** if the app uses Angular `@defer`; this consumer
   does not.
4. The generated directory must be in the Angular program (`tsconfig.app.json` `include`) and gitignored.

## Packaging fixes found by the external consumer

All three are in the package and were invisible in the workspace:

1. **`enabled` failed open.** `ServerComponentsOptions.enabled` was a required boolean, but a
   `vite.config.ts` is rarely type-checked: a config that omitted it silently disabled the plugin, the
   real Server Component, its repository and both markers shipped in the browser bundle, and nothing
   failed. `enabled` is now optional and defaults to `true` (`false` stays the plain-SSR control build).
   Unit test: "is ON when `enabled` is omitted".
2. **SSR JIT fallback from `node_modules`.** The runtime is partial-compiled. In the workspace it is a
   linked package that Vite bundles through Analog's linker; installed from a tarball Vite externalizes
   it for Node SSR, Nitro loaded the raw `ɵɵngDeclare*` declarations and the page failed with
   "The directive 'StrataClientBoundary' needs to be compiled using the JIT compiler". `config()` now
   also returns `ssr.noExternal: ["@strata-sc/server-components"]`, next to the existing
   `optimizeDeps.include`. It is universally correct (the package is always a partial-compiled Angular
   library), touches only this package's own resolution, and is covered by a unit test and by every SSR
   assertion of the external gate (they fail without it).
3. **Dangling source maps and no LICENSE.** The `.js.map` and `.d.ts.map` files pointed at `src/`, which
   is not shipped, so `vite` dev logged "Sourcemap … points to missing source files" for every runtime
   module. `tsconfig.runtime.json` now sets `inlineSources: true` and `declarationMap: false`. The
   tarball also had no license text (`pnpm pack` does not inherit the root `LICENSE`); a package-local
   `LICENSE`, identical to the repository's MIT license, was added.

These are packaging corrections of a private package. They do not change a public API or a published
release, so no Changeset was added.

## Verdicts

| Area                                   | Verdict                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tarball integrity                      | **GO**                                                                                     |
| Declaration portability                | **GO** (TypeScript 5.9.2 and 6.0.3, `skipLibCheck: false`, 0 diagnostics)                  |
| External install                       | **GO**                                                                                     |
| Node production consumer               | **GO**                                                                                     |
| External dev server                    | **GO** (one server-owned edit; the exhaustive matrix stays in `test:server-component-dev`) |
| Cloudflare/workerd consumer            | **GO** (local workerd only)                                                                |
| Graph confidentiality                  | **GO**                                                                                     |
| **Overall distribution qualification** | **GO** for a private tarball; not a published candidate                                    |

## Remaining publication blockers (not done here)

Everything below is for a follow-up and was deliberately not touched:

- `private: true` → removed; `version` 0.0.0 → first prerelease; `publishConfig` (`access: public`,
  `tag: next`).
- Add to `PUBLISHABLE_PACKAGES`, remove from `EXCLUDED_PACKAGES`, and teach the release inspector and
  `release.yml` the `dist/fesm2022` layout (the generic inspector requires `dist/index.js`).
- A Changeset for the first release; the `next` dist-tag already exists as the experimental channel.
- README install instructions (currently none, by design) once a version exists on the registry.
- The qualification used a tarball, not the registry: a published candidate still has to be installed
  from npm with `provenance` checked.
- Open limitations that are not packaging: Angular Router navigation into a Server Component is NO-GO;
  the pre-scan follows only relative re-exports under `sourceDir`; no deployed environment; peers
  untested outside Angular 22.1.7 / Vite 8.3.0.

**Version recommendation:** `0.1.0` under the `next` dist-tag would be defensible on this evidence; the
packaging blockers are fixed. Stay private only if the open limitations above are unacceptable for an
experimental prerelease. The version was not set here.
