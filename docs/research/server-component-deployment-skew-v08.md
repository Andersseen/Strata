# Server Components deployment version skew (0.8.0)

Date: 2026-10-23
Baseline: `main` at `ef31c0d0d73ef57f3228856bc70e5b7833d5df0f` (`@strata-sc/server-components` 0.7.0)
Branch: `feat/server-components-deployment-skew-v08`

## Question

When the document a server rendered and the browser script that hydrates it come from different
application builds, can Strata detect it before any island is created, classify it without confusing it
with tampering or ordinary failures, and optionally recover, using supported APIs only and without
weakening any fail-closed guarantee?

## Pinned tuple

The external consumer (installed from the packed tarball with npm, outside the workspace) used:

| Package                               | Version     |
| ------------------------------------- | ----------- |
| Node                                  | 22.23.1     |
| Angular core/common/compiler/router   | 22.2.3      |
| Analog platform / vite-plugin-angular | 2.7.2       |
| Nitro (nitropack)                     | 2.13.4      |
| Vite                                  | 8.3.0       |
| TypeScript                            | 6.0.3       |
| Wrangler (local workerd)              | 4.135.0     |
| Playwright (Chromium)                 | repo-pinned |

## The confirmed problem

The protocol attribute (`1`/`2`) proves only that two runtimes agree on a wire format. Reproduced with two
real builds: release B renames a client island's input (`product` → `item`) and changes the server
message while keeping protocol `2`. Before this change a B document with an A script was refused only by
accident, as an unrelated input error (`prop "item" is not an input of the component`), and with an
unchanged input name it would hydrate the wrong implementation. No build identity existed, and the
documented position was that stale-client recovery was "not implemented".

## Implemented compatibility model

- **Identity.** An opt-in, consumer-supplied label: `strataServerComponents({ buildId })`, validated
  (`^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$`, public, never a secret). A package version is not used (two
  deployments share one Strata version) and neither is an automatic fingerprint: Vite's `client`, `ssr` and
  Nitro environments cannot be given a reliable common content hash through supported hooks, while a value
  the consumer passes to one `vite build` is, by construction, identical in all of them. Random or
  counter-based values were rejected for the same reason (independent environments would disagree).
- **Delivery.** Vite `define` of `__STRATA_BUILD_ID__` from the plugin's `config()` hook, for every
  environment. The runtime package is already bundled into the SSR graph (`ssr.noExternal`), so the constant
  reaches the server renderer and the browser. No runtime lookup, request state, global, generated server
  module or private source path is involved; a private module never has to be importable to expose it.
- **Wire.** `StrataClientBoundary` writes `data-strata-build` on each boundary host. Protocol numbers are
  unchanged; runtimes that predate the feature ignore the attribute.
- **Browser check.** In the per-host preflight, after the host's own `data-strata-client` checks and
  before the registry, protocol and props. Outcomes are stable `category` values on `StrataBoundaryError`;
  only two well-formed different identities produce `StrataBuildMismatchError`
  (`build-mismatch`); a missing or malformed identity is `build-identity` and is never treated as a
  deployment. A browser without an identity enforces nothing (backward compatible).
- **Recovery.** `provideSkewRecovery({ reload, maxReloads, windowSeconds, onMismatch })`. Off unless
  `reload: true`. Only a `build-mismatch` can reload; the reload is `location.reload()` of the current
  document (same origin by construction, no computed URL). Bounded by a `{count, since}` record in the tab's
  `sessionStorage`, written before the reload and read back; blocked, forgetful or implausible storage means
  no reload. One reload per application instance however many hosts are refused. The error is always
  rethrown to the `ErrorHandler` with `error.recovery` set.

## Backward compatibility

Without `buildId`: no `define`, no attribute, no check, no new reload path; the existing suites and the
`legacy` release of the matrix (same sources as A, built without the option) hydrate as before. A newer
document with a script that does not enforce an identity hydrates as before (the stamp is ignored). Existing
`StrataBoundaryError` messages are unchanged. Public API added: `buildId`, `provideSkewRecovery`,
`StrataBoundaryError` (now exported, with `category`), `StrataBuildMismatchError`, and the types
`BoundaryFailureCategory`, `BuildRecoveryOutcome`, `BuildMismatch`, `SkewRecoveryOptions`.

## Migration boundary

A script built before this feature cannot read `data-strata-build`. The first deployment that enables it
cannot repair clients already running an older script; a pre-identity document with a new script is refused
as `build-identity`, not recovered; rolling back to a pre-identity build leaves open tabs unable to detect
the skew.

## Two-build qualification

`pnpm test:server-component-deployment-skew` packs the real package, partial-compiles and packs the
Angular package-island library, installs everything with npm outside the workspace, and builds three
releases from authored sources: **A** (`rel-2026.10.1`), **B** (`rel-2026.10.2`, renamed client input,
different server message) and **legacy** (A's sources, no option), each separately for Nitro Node and for the
Cloudflare Pages preset. Each release runs on its own real server (Nitro Node, or `wrangler pages dev` on
local workerd). An "edge" in front answers a document from one release and assets from another. The fixture
is built with a **stable entry URL** (`/assets/entry.js`): with hashed entry names a document and a script of
different builds cannot meet, and aliasing a hashed name made the entry evaluate twice (a harness artefact
found and removed during development). Only documents are ever rewritten in the labelled negative
controls.

Result: **PASS, 125 checks** (Node production and local workerd, 10 + 10 phases).

| Scenario (matrix item)                                                                                                                                                              | Result |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A doc + A script, B doc + B script: 4 boundaries (v1 and v2, an npm package island) hydrate over the SSR nodes, interactive, no console error (1, 2, 18)                            | pass   |
| `/pair`: two hosts, identical selectors and props, 8 boundaries on their own hosts (7, 8)                                                                                           | pass   |
| A doc + B script and B doc + A script: `StrataBuildMismatchError`, both build ids named, nothing hydrates, DOM inert, callback received the ids, one document request (3, 4, 5, 10) | pass   |
| B's markup uses protocols 1/2 that A fully supports, yet A reports a build mismatch, not an input error (5)                                                                         | pass   |
| Edited protocol, same build (negative control): `protocol` category, no mismatch, no reload even with recovery on (6)                                                               | pass   |
| Legacy doc + A script: `build-identity` (missing), no reload; A doc + legacy script and legacy + legacy hydrate as before (15, 18)                                                  | pass   |
| Empty / markup-valued attribute (negative controls): `build-identity`, value not echoed, no reload (15)                                                                             | pass   |
| One host rendered by B beside a healthy A host (real fragments spliced): healthy interactive, refused inert, no reload (9)                                                          | pass   |
| Recovery on, CDN converges: exactly one reload, same URL, `{count:1,since}` only, B hydrates, interactive (11)                                                                      | pass   |
| Recovery on, mismatch persists: one reload, then `exhausted`, inert, no third request; manual reload gets no automatic one (12, 13)                                                 | pass   |
| Tab already used its attempt: never reloads (13)                                                                                                                                    | pass   |
| `sessionStorage` throws / accepts and forgets writes: `storage-unavailable`, no reload (16)                                                                                         | pass   |
| Rollback B → A with a stale B script: one bounded reload, A hydrates; Back and Forward hydrated, not stale (14, 17)                                                                 | pass   |
| Client output, assets and source maps free of server markers and server-owned module names; public build id present (positive control)                                              | pass   |

Hosted CI, a deployed Cloudflare Pages run and production adoption are separate and are recorded below.

## Honest limits and findings

- The mismatch is read from markup the client can edit. The worst a tampered but well-formed value can do
  is cause one bounded reload of the user's own document per window, equal to the user pressing reload.
  There is no independent server confirmation; none was added because no supported seam provides one
  without a new endpoint.
- Reload destroys healthy islands and unsaved state, hence opt-in. Recovery succeeds only if the next
  document is compatible: after a rollback that keeps serving incompatible assets it stops at `exhausted`.
- Attempts are counted per tab and window, not per build pair, because a pair-keyed record loops when two
  servers alternate (A,B), (A,C), (A,B)…; the cost is that a second deployment inside the window is not
  auto-recovered.
- `sessionStorage` is the only client persistence: counters and a timestamp, no URL or identity.
- Not covered: streaming SSR, Angular Router subtree navigation, service workers, cross-tab coordination,
  a deployed Pages project (**NOT RUN**: no sanctioned workflow was invoked), real CDN caching behaviour,
  and a stable entry URL being the only mixing mechanism modelled.

## Verdicts

- Detection and classification: **GO** on the qualified tuple, Node and local workerd.
- Opt-in bounded reload: **CONDITIONAL GO** (local evidence only; the single-reload bound holds, the success
  case needs the CDN to converge).
- Deployed Cloudflare Pages: **NOT RUN**. Production adoption: **none**. M4, M5 and Strata 1.0 remain open.
