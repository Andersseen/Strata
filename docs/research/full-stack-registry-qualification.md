# Full-stack Strata: published-registry qualification

Date: 2026-11-02  
Baseline: `e2734b191208a979ef89c94b08ce1971cb5551db` (`main` after PR #157)  
Branch: `test/full-stack-registry-qualification`

## Verdict first

The published tuple `@strata-sc/core@0.2.2` + `@strata-sc/analog@0.12.0` +
`@strata-sc/server-components@0.13.0`, installed from https://registry.npmjs.org at those exact versions into
the existing external full-stack Analog fixture, passes the whole shared verifier on Nitro Node, on a local
Cloudflare Pages/workerd build, and on the isolated real Cloudflare Pages project.

| Level                                             | Result for this tuple                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Unit qualified (tuple selection, lock verifier)   | 19 vitest cases, including corrupted-artifact negative controls                          |
| Source-packed consumer (unchanged)                | PASS, 366 checks, rerun on this branch                                                   |
| **Published-registry qualified (Node + workerd)** | **PASS, 359 checks, 0 failing** (`pnpm test:full-stack-registry-consumer`)               |
| Local workerd qualified                           | PASS (inside the run above and the deployed runner's rehearsal)                          |
| **Deployed qualified (isolated Pages project)**   | **GO**, [run 41409890385](https://github.com/Andersseen/Strata/actions/runs/41409890385) |
| Hosted CI qualified (PR gates)                    | see the pull request                                                                     |
| Production adopted                                | **NO.** A synthetic fixture is not a real application.                                   |

One successful tuple is not a compatibility claim. It says nothing about other versions, other Angular/Analog/
Nitro tuples, authentication, tenant caching, shared controller/SSR Angular DI, SPA subtree navigation or
streaming SSR. M4, M5 and Strata 1.0 are not closed by this result.

## The gap

Every earlier full-stack gate qualified tarballs packed from the checkout (`pnpm pack`). A packed tarball can be
correct while the published artifact is not (a file filtered by `files`, a dependency range rewritten at
publish, a registry integrity mismatch). The only registry gate (`test:server-component-registry-consumer`)
covers one package and a focused subset. Nothing proved that the three published packages, resolved by npm
together, work in one application and on a real Cloudflare deployment.

## What was reused, what is new

Reused unchanged: the fixture `tests/full-stack-package-consumer/fixture`, `httpSuite`, `islandSuite`,
`navigationSuite`, routing/streaming/correlation observers, the module-graph and canary scans, the
build-time server-only firewall, Wrangler/workerd startup, the concurrency matrix, the Cloudflare readiness
logic (HTTP then fresh Chromium contexts, edge-404 diagnostics), `deployToPages`, and the project allowlist.

New:

- `tools/release/lib/registry-tuple.ts`: exact-version selection (`STRATA_REGISTRY_{CORE,ANALOG,SERVER_COMPONENTS}_VERSION`,
  default the manifests; dist-tags and ranges are refused, naming the package through `registry-version.ts`),
  parsing of `npm view`, tuple coherence (`@strata-sc/analog` must pin the selected core exactly) and the
  lock verifier. Pure and unit tested.
- `tools/server-components/lib/full-stack-registry-install.ts`: registry lookup, install, identity checks.
- `verifyInstalledTree` extracted from `full-stack-install.ts`: the entry-point, single-copy, `npm ls` and
  tuple-recording checks now serve both candidates (the packed behavior is unchanged; the packed run still passes).
- `--registry` on `full-stack-consumer.ts` and `full-stack-deployed-cloudflare.ts`
  (`pnpm test:full-stack-registry-consumer`, `pnpm test:full-stack-registry-deployed-cloudflare`).
- `source`, `*_version` inputs on the existing manual `full-stack-deployed-cloudflare.yml`
  (default `packed`, unchanged). A separate workflow file could not have been dispatched from a branch
  before it existed on `main`.

## What the registry mode proves

- Each version exists on npm. A missing one exits **3, NOT AVAILABLE**: not a runtime failure, not a GO,
  nothing substituted, no deployment (verified with `@strata-sc/server-components@0.14.0`, which is only a
  Version Packages proposal).
- Dependency specs are exact registry versions; the consumer's `package-lock.json` resolves each package from
  the registry tarball URL with the registry's sha512 and contains no other `@strata-sc` entry.
  A downloaded tarball (`npm pack`) must hash to the same integrity, pass the release inspector, and match the
  installed directory byte for byte (27 / 63 files; no `src/`; no symlink).
- One copy each of Core, Analog, Server Components, `@angular/core`, `@angular/compiler`, `typescript`;
  no `@strata-sc/h3`; the six public entry points resolve to `node_modules/.../dist`; nothing resolves into the
  checkout; `npm ls` reports no Strata/Angular/Analog/Vite/Nitro problem.
- Declarations under TypeScript 6.0.3 and 5.9.2 with `skipLibCheck: false`, from the installed packages
  (the TS 5.9 consumer installs the same exact versions).
- Node production and Cloudflare Pages builds, controller HTTP, Server Component SSR, hydration and
  interaction, document navigation, routing, streaming/correlation observers, confidentiality scans, workerd
  without JIT errors, and, deployed, bounded concurrency.

### Negative controls

- Unit: dist-tag/range refusal, analog pinning another core, registry answering another version, corrupted
  integrity, `file:` resolution, nested duplicate core, unexpected `@strata-sc/h3`, missing/mismatched lock
  entries, non-exact dependency specs.
- In the runner: the lock verifier is applied to a tampered copy of the real lock and must fail.
- CLI: `STRATA_REGISTRY_CORE_VERSION=latest` exits 2 with the reason; an unpublished version exits 3.

## Identity of the evaluated candidate

| Package                        | Version | Tarball / integrity                                                                                                |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `@strata-sc/core`              | 0.2.2   | `https://registry.npmjs.org/@strata-sc/core/-/core-0.2.2.tgz` `sha512-Xr6bMt7f…johFkA==`                           |
| `@strata-sc/analog`            | 0.12.0  | `https://registry.npmjs.org/@strata-sc/analog/-/analog-0.12.0.tgz` `sha512-jHkt/GbJ…BWAuA==`                       |
| `@strata-sc/server-components` | 0.13.0  | `https://registry.npmjs.org/@strata-sc/server-components/-/server-components-0.13.0.tgz` `sha512-xoJRA5ZS…oh5Lg==` |

Installed tuple (from the deployed run's lock and `node_modules`): Angular core/common/compiler/router/
platform-server 22.2.3, `@angular/build` 22.1.8, `@analogjs/platform` and `router` 2.7.2,
`@analogjs/vite-plugin-nitro` 2.9.5, nitropack 2.13.4, h3 1.15.11, Vite 8.3.0, TypeScript 6.0.3, rxjs 7.8.2,
Wrangler 4.135.0, Node v22.23.4 (hosted) / 22.x (local). The verifier and fixture came from commit
`9a9a0369d84cac6d635b7cb0fe489ad29e0e1057`; the packages did not.

The fixture comes from the checkout while the packages come from npm. A future fixture that needs an
unpublished API would fail against an older published tuple; that is a real NO-GO for that tuple, not a defect
of the verifier, and is reported as such.

## Real deployment

Dispatched through the repository's existing manual workflow with `source=registry` (it forces
`STRATA_FULLSTACK_PAGES_PROJECT=strata-fullstack-qualification`, `STRATA_FULLSTACK_REQUIRE_DEPLOYED=1`; the
runner refuses any other project, no DNS/route/binding change, no npm publish).

| Field                                       | Value                                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Actions run                                 | [41409890385](https://github.com/Andersseen/Strata/actions/runs/41409890385)                         |
| Candidate                                   | PUBLISHED-REGISTRY CANDIDATE (the tuple above)                                                       |
| Pages project                               | `strata-fullstack-qualification` (existing; not created by this run)                                 |
| Deployment id / URL                         | `74655ea8-35b7-44c8-91eb-238a544b607e` / `https://74655ea8.strata-fullstack-qualification.pages.dev` |
| Build digest (sha256)                       | `1334097814996fcdce46d6c40255b32fdf8992b288bcc4d007454188ee8b2a69`                                   |
| Compatibility date / flags                  | 2026-09-21 / none (`nodejs_compat` not enabled)                                                      |
| Readiness                                   | 5 consecutive correct page and API answers, 0 not-ready, 0 browser not-ready                         |
| Controller / SSR / island / confidentiality | GO / GO / GO / GO                                                                                    |
| Bounded concurrency matrix                  | GO: 829 requests, 0 mismatches, 0 edge responses, 0 transport errors, 0 unclassified                 |
| Real public Cloudflare deployment           | **GO**                                                                                               |

The historical concurrency anomaly of the source-packed run 2 (1 wrong answer in 25 concurrent requests,
2026-10-15, [record](full-stack-deployed-cloudflare.md#deployment-record)) did not recur here, as it did not
recur in the later source-packed runs. Its root cause is still **unconfirmed** and remains a residual risk; one
clean run of a different candidate does not explain or close it. The earlier NO-GO runs remain valid history
for their candidate.

## Limits

- One tuple, one fixture, one date. Nothing is said about other versions or about newer ones.
- Synthetic fixture: no authentication, no tenant cache isolation, no shared controller/SSR Angular DI.
- Workerd JIT limitations are unchanged; no `nodejs_compat`.
- Registry qualification is a manual/hosted gate, not a PR gate: it depends on the network and on versions that
  exist only after a release, and the deployed part needs credentials and creates a real deployment.
- When PR #158 releases `@strata-sc/server-components@0.14.0`, that tuple must be qualified separately; this
  report does not cover it.

## Commands

```sh
pnpm test:full-stack-registry-consumer                 # published tuple: Node + local workerd
pnpm test:full-stack-registry-deployed-cloudflare      # + local rehearsal; NOT RUN without deployment
STRATA_REGISTRY_ANALOG_VERSION=0.11.0 pnpm test:full-stack-registry-consumer   # another exact tuple
gh workflow run full-stack-deployed-cloudflare.yml -f source=registry          # real deployment
```
