---
type: research
---

# Server Component document-navigation fallback

## Verdict

**CONDITIONAL GO for a consumer-owned, explicitly configured experimental fallback.**

The candidate prevents the fixture's Angular SPA transition from activating the empty Server
Component surrogate. It cancels the transition in a public `canActivate` guard and starts a new
browser document request with the target URL. This is a document reload, not seamless SPA
navigation and not hydration of a newly fetched subtree.

The starting `main` SHA was `f62722b3e0ba23c80e61669bca7f4f056081979c`. This increment promotes
the qualified policy to the optional `@strata-sc/server-components/navigation` package entry;
the fixture consumes that entry and no package was published.

## Qualified versions

- Angular core/compiler/router: `22.1.7`; platform-browser `22.2.1`; platform-server `22.2.2`
- Analog router/platform and Vite plugins: `2.7.2`
- Nitro: `2.13.4`
- Vite: `8.3.0`
- TypeScript: `6.0.3`
- Node: `22.23.1`
- Wrangler: `4.135.0`; compatibility date `2026-09-21`

## Public extension points investigated

Angular `CanActivateFn`, `CanMatchFn`, `Router`, `RouterStateSnapshot`, navigation events and browser
`Location` APIs were inspected. Analog 2.7.2's public `defineRouteMeta` accepts Angular `canActivate`
guards, so a file-based page can opt into a consumer policy. `RouterStateSnapshot.url` preserves the
target query and fragment. `Router.navigated` is the public lifecycle signal used to distinguish the
initial bootstrap navigation from subsequent client transitions; no timeout or private hydration
state is involved.

Resolvers, `CanMatchFn`, `RouteReuseStrategy`, Analog `load`/server functions and router events do
not provide a server-rendered subtree or a public attach-and-hydrate lifecycle. Angular hydration
internals, `NGH_DATA_KEY`, DOM injection, HTML fetching, renderer patches, history patches and global
click interception were rejected.

## Candidate

The package exports `strataDocumentNavigationGuard`, which a consumer attaches through the page's
`defineRouteMeta({ canActivate: [...] })`. On the server and on the browser's initial navigation it
returns `true`. After the initial client navigation it validates a same-origin target, calls the
browser `Location.assign` with its path, query and fragment, and returns `false`, so activation
cannot render the empty surrogate. The fresh document then performs normal SSR and Angular
hydration; its initial navigation is allowed, preventing a loop.

The fixture's separately identified `/server-component-unprotected` route deliberately has no guard,
so the historical empty-surrogate failure remains observable without a URL-controllable bypass on
the production-style guarded route.

## Results

`pnpm test:server-component-navigation` passes on Nitro `node-server`:

- direct SSR, hydration, DOM reuse and one interaction remain passing;
- RouterLink and `navigateByUrl` each make a real document request;
- destination HTML contains server-rendered data, with one hydrated island and no duplicate client
  component;
- query parameters and `#details` are preserved;
- Back, Forward and re-entry produce fresh hydrated documents with no reload loop;
- leaving to an ordinary Angular route still destroys the island with no orphaned view;
- the separately unprotected control route still produces the same-realm, empty surrogate with no
  server request or warning;
- graph and runtime scans still exclude server-only markers from browser assets and loaded scripts.

`pnpm test:server-components:cloudflare` passes its Cloudflare Pages build and local workerd runtime.
The same fallback flow is exercised against the Worker: both document requests render server data and
hydrate one island, query/fragment values survive, and the browser reports no errors. The existing
Angular DI workerd limitation remains characterized separately as NO-GO.

## Contract and remaining limitations

Supported: explicit plain document navigation into Server Components.

Experimental: consumer-owned automatic document-navigation fallback for designated routes, qualified
on the versions and Node/workerd environments above.

Unsupported: SPA hydration of a newly rendered Server Component subtree, streaming, generic automatic
route discovery, package-level router integration, authorization and Strata 1.0 qualification.

Consumers must explicitly designate protected routes and accept a full document navigation. The
fallback has normal browser reload semantics, including focus and scroll behavior, and must not be
described as seamless routing.
