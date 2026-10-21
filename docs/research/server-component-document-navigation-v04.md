# First-class document navigation

Status: locally qualified implementation on the feature branch `feat/server-components-document-navigation`; hosted CI
is pending at the time of writing. Starting `main` SHA: `21baee81f644b46b2142ca3dfd789a691417f16c`.

Document navigation is the one supported way to enter a Server Component route: the browser requests a new HTML
document, Angular bootstraps and hydrates it. This change makes that path a first-class API instead of a convention
and a guard. It does **not** add Angular Router subtree hydration; see [Known limitations](#known-limitations).

## Public API

All exports come from `@strata-sc/server-components/navigation` (the optional entry; `@angular/common` and
`@angular/router` are its peers).

| Export                                                                                         | Kind            | Purpose                                                                |
| ---------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------- |
| `StrataDocumentLink`                                                                           | directive       | `a[strataDocumentLink]`: a native anchor with a computed `href`        |
| `StrataDocumentNavigator`                                                                      | service         | `resolve()` and `navigate()` for programmatic document navigation      |
| `strataDocumentNavigationGuard`                                                                | `CanActivateFn` | cancels a later Router activation and retries it as a document request |
| `StrataDocumentNavigationError`                                                                | error           | thrown for an invalid, unsafe or cross-origin destination              |
| `StrataDocumentDestination`, `StrataDocumentNavigationExtras`, `StrataDocumentNavigateOptions` | types           | public inputs                                                          |

The three behaviours share one internal resolver (`resolve.ts`): a destination becomes a same-origin, root-relative
document URL through Angular's `Router.createUrlTree`, `UrlSerializer` and `Location.prepareExternalUrl`. There is no
router implementation, no global state and no monkey patch.

## Link semantics

- Renders a real `<a href>`; SSR emits the final `href` (encoded, with base href). The click is never intercepted
  or `preventDefault`ed, so history, Cmd/Ctrl-click, middle-click, `target`, keyboard activation and fragments are native.
- Destination: route commands, `UrlTree`, or a root-relative string. `queryParams`, `fragment` and `relativeTo` apply to
  commands; combining them with a string throws. `null`/`undefined` renders no `href`.
- Unsafe input throws `StrataDocumentNavigationError` (message never contains query parameters): `https:`/`javascript:`/
  `data:` schemes (any case), `//host`, non-root-relative strings, backslashes and control characters, malformed URLs
  (`Router.parseUrl` would silently turn them into `/`, so `UrlSerializer.parse` is used), and a base href on another origin.
- `strataDocumentLink` together with `routerLink` on one anchor throws.

## Programmatic navigation semantics

`navigate(destination, { queryParams, fragment, relativeTo, replace })` resolves like the link, checks the resolved URL
against the current document origin, and calls `Location.assign`/`replace`. It returns `true` when a navigation started,
`false` otherwise: SSR (no throw, no global access; the document is read through `DOCUMENT`), the current URL, or the same
navigation already pending (state is per injector). It never calls `Router.navigate()`.

## Guard semantics

- SSR and the initial browser navigation: allowed.
- Later Router activation: returns `false` from `canActivate` (so the empty surrogate is never created) and requests the
  document via the navigator, using `Location.prepareExternalUrl(state.url)`.
- **Hardening over 0.3.0:** the target now includes the base href (the previous guard dropped it); a navigation to the
  already-displayed URL is cancelled without a request (no reload loop, e.g. a fragment-only or same-URL Router
  navigation); an unresolvable or cross-origin target is cancelled and not retried; `Location` unavailable cancels.
- Limits: opt-in per route; a popstate to a guarded entry becomes a document navigation, not an SPA restore.

## Findings during implementation

1. **No `<base>` makes Angular's base href absolute.** `PathLocationStrategy` falls back to `document.location.origin`, so
   `prepareExternalUrl('/release')` returned `http://127.0.0.1:…/release` in Relay (which has no `<base>`) and the first
   implementation threw during hydration. The resolver strips exactly the current document origin (SSR: the request
   origin) and still rejects any other origin.
2. **`Router.parseUrl` swallows malformed URLs into `/`.** The resolver uses `UrlSerializer.parse` so `'/a/(b'` is rejected.
3. **The `/navigation` entry was not linked in `vite` dev.** The plugin pre-bundled only the main entry, so the partial-compiled
   injectable fell back to the JIT compiler and the page died. The plugin now also pre-bundles
   `@strata-sc/server-components/navigation` when the app resolves `@angular/router` (unit-tested both ways).
4. The old guard dropped the base href for apps with a non-root `<base>`.

## Evidence

All commands run on the branch from a clean install. Node 22.23.1, Angular core/compiler 22.1.7, common 22.2.3, router 22.2.2,
Analog 2.7.2/router 2.8.1, Vite 8.3.0, TypeScript 6.0.3 (5.9.2 declaration consumer), Playwright/Chromium 1.62.1.

| Gate                                                                                                                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server-components` unit tests (resolver: commands, query, fragment, encoding, unicode, encoded separators, base href, UrlTree, schemes, malformed, origin stripping, no-leak errors; plugin pre-bundling; source-boundary checks) | passed                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test:server-component-navigation` (Nitro `node-server`)                                                                                                                                                                               | PASS: link `href` equals `/server-component?product=42&label=a%20b%26c#details` in the live DOM and in the SSR HTML; click = one document request, new JS realm, Navigation Timing `navigate`, island hydrated once, one handler per click; programmatic navigation likewise; Back/Forward; Ctrl/Cmd-click, middle-click and `target=_blank` open a new tab natively; the unprotected-route negative control still renders the empty surrogate |
| `pnpm test:server-components:cloudflare` (local workerd)                                                                                                                                                                                    | PASS: the identical link/navigator checks (shared `checkLinkFlow`)                                                                                                                                                                                                                                                                                                                                                                             |
| `pnpm test:relay:server-components`                                                                                                                                                                                                         | PASS: Relay overview → `/release` (document link) → `/incidents?from=release#incident-digest-title` (programmatic) → Back → Forward, islands hydrated once, no Angular errors                                                                                                                                                                                                                                                                  |
| `pnpm test:full-stack-package-consumer`                                                                                                                                                                                                     | PASS: tarballs installed outside the workspace; strict TS 6.0.3 and 5.9.2 (`skipLibCheck:false`); AOT with strict templates over `StrataDocumentLink`; Node and workerd document-link and navigator flows                                                                                                                                                                                                                                      |
| `pnpm test:server-component-dev`                                                                                                                                                                                                            | N. scenario: server-owned edit, client-island edit, invalid server source (fails closed, no loop, no leak) and recovery, each followed by document hops between two Server Component routes                                                                                                                                                                                                                                                    |

Protocol coexistence: the boundary suites (`test:server-components`, `test:server-component-package-consumer`, Relay's
v1-downgrade test) are unchanged and run on the same branch; the navigation changes do not touch the graph, the protocol
or the resource limits.

## Authorization and failure behaviour

Unchanged and re-run: `pnpm test:server-component-authorization`. The protected fixture route now links with
`StrataDocumentLink` and carries the guard; 200/401/403/404/503, Back/Forward re-requesting the server and the HttpOnly
credential checks pass as before. Unexpected Angular SSR failures may still return HTTP 200; that is **not** fixed here.

## Security notes

No `innerHTML`, `DOMParser`, `document.write`, `eval` or `.href =` in the entry (asserted by a source test); no private Angular
APIs; no module-scope mutable state; browser globals only via `DOCUMENT`. Server-only code stays out of every browser asset
(the existing leak scans in every suite pass). Query parameters are never included in errors or logs.

## Known limitations

- Seamless Angular Router subtree hydration, streaming SSR and an SSR-error-status redesign are unsupported and unchanged.
- An unguarded Router activation into a Server Component route still renders the empty surrogate (kept as a negative control).
- Route discovery is not automatic: each route opts in with the guard.
- `HashLocationStrategy` is not supported; `<base>`-less apps are supported (see finding 1).
- Angular JIT DI on workerd remains NO-GO. Package-source hot reload remains absent (external package updates need a Vite restart).
- bfcache: tests assert the visible page and a fresh hydrate on Back, not whether the browser reloaded or restored it.

## Release ordering

`@strata-sc/server-components` is `0.3.0` on npm and in `package.json`. The previous feature's Changeset
(`quiet-pandas-own.md`, package islands) is still pending and a release PR (#108, `0.4.0`) is open. This branch adds its own
minor Changeset (`calm-links-navigate.md`). If #108 is merged and published first, this change becomes `0.5.0`; if both are
pending when a release PR is next generated, Changesets aggregates them into a single `0.4.0`. Nothing is published, versioned
or tagged by this branch.

## Remaining 1.0 blockers

Router-integrated Server Component navigation (or a ratified document-only contract for the real consumer), streaming SSR,
an SSR-failure status contract, real-consumer production adoption, a deployed multi-tenant isolation result and a stable
protocol/API freeze.
