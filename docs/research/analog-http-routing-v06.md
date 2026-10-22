# Analog HTTP routing and API boundary (0.6.0 candidate)

Evidence for the opt-in `apiBoundary` option of `@strata-sc/analog`. Experimental fixture evidence, not a
production deployment and not Strata 1.0 certification.

- **Starting `main`:** `b7ab2d6173fc3710ffb9fed92b64a612ba8e8063` (merge of PR #112), branch
  `feat/analog-http-routing-v06`.
- **Versions on main:** `@strata-sc/core` 0.2.2, `@strata-sc/analog` 0.5.0,
  `@strata-sc/server-components` 0.6.0. One minor Changeset targets `@strata-sc/analog` 0.6.0; no version
  is bumped by hand and nothing is published or deployed from the branch.
- **Tuple:** Analog 2.7.2, Nitro 2.13.4, h3 1.15.11, radix3 1.1.2, Angular 22.1.7 (workspace) / 22.2.3
  (packed consumer), Node 22, local workerd through Wrangler 4.135.0.

## The problem

`registerControllers()` only adds routes to Nitro's router. Analog's SSR renderer is registered on the same
router as a `/**` route for every method, so a request that matches no Strata or native route is rendered as
an HTML page, and so is a known path with an unsupported method. The unit control in `api-boundary.test.ts` reproduces it with Nitro's own composition (a preemptive
router plus a `/**` HTML route): without `apiBoundary`, `GET /api/nonexistent` answers `200 text/html`. It was
not separately re-measured on the real fixture before the change.

## What the real router does

Probed on h3 1.15.11 before designing anything (the behaviours the design relies on):

| Behaviour                                                                                                                            | Consequence                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `router.add(path, handler)` without a method serves every method                                                                     | One fallback handler can see every method, including `TRACE` and `PROPFIND`                                      |
| A node without a handler for the method falls through to the next less specific node that has one (`matchAll`)                       | A fallback on `/<prefix>/**` receives only what no more specific route handled; native routes are never shadowed |
| `/api/**` does **not** match `/api` or `/api/`                                                                                       | The boundary registers both `/<prefix>` and `/<prefix>/**`                                                       |
| The router decodes the path itself (`%34%32` → `42`, `%2F` stays encoded), ignores one trailing `/`, and routes `//` to the wildcard | The boundary matches the string the router used (`event.path`) and never decodes again                           |
| radix3 does not backtrack out of a static branch (`/a/new/x` with routes `/a/new/y`, `/a/:id/x` reaches the wildcard)                | The boundary serves the matching Strata route instead of answering a 405 that contradicts its route table        |
| Nitro's `router` is `preemptive`; Analog's renderer is a `/**` route                                                                 | An unmatched `/api/*` is rendered as HTML unless something more specific exists                                  |

## Final public API

```ts
registerControllers(nitroApp.router, [OrdersController], {
  apiBoundary: {
    prefixes: ["/api"], // required, explicit, static segments only
    nativeRoutes: [{ path: "/api/health", methods: ["GET"] }], // optional shared metadata
    head: "derive", // default; "off" answers HEAD like any unsupported method
    options: "allow", // default "off"
  },
  guards: [authGuard],
  interceptors: [timingInterceptor],
});
```

New public types: `StrataAnalogApiBoundaryOptions`, `StrataAnalogNativeRoute`,
`StrataAnalogBoundaryMethod`. No H3 or Nitro type appears in the declarations. Calls without `apiBoundary`
behave exactly as before; the only structural change is that the router registry also remembers the
registered handler and method of each Strata route (needed by `HEAD`).

## Boundary ownership

- Only listed prefixes are owned. A prefix is one or more static segments (`[A-Za-z0-9._~-]`); `/`,
  wildcards, parameters, repeated separators, queries and non-strings are configuration errors, so the
  website can never be owned by accident. A trailing `/` is normalized away. Prefixes that are equal or
  nested are rejected.
- Mechanically: one fallback registered for every method on `/<prefix>` and `/<prefix>/**`. Nitro's router
  prefers any more specific route that handles the method, so native routes (static, `:param` or deeper
  wildcards), Strata routes and Analog endpoints win.
- State is a `WeakMap` keyed by the router: the registered routes, the owned prefixes and their policy.
  Nothing is process-wide, so independent Nitro apps and server lifetimes never share metadata. Routes
  registered in later calls, or before the prefix was declared, are part of the same boundary.

## 404

A request below an owned prefix that nothing handled answers:

```http
HTTP/1.1 404 Not Found
content-type: application/json; charset=utf-8
cache-control: no-store

{"error":"not_found"}
```

The body is a constant: no path, query, route table, controller name or stack. A matched handler that
throws `StrataAnalogHttpError(404, "not_found")` has the same public body but did run its guards,
interceptors and factory; the tests tell them apart by observing the factory. A path parameter is never an
unknown route: `GET /api/products/not-a-route` reaches the `/:id` handler, which decides (application 404
in the fixture, with no `Allow`).

## 405 and Allow

If one or more registered Strata patterns (or declared native routes) match the path and none handles the
method: `405`, `{"error":"method_not_allowed"}`, same headers plus `Allow`. `Allow` is the union of the
methods of every matching pattern (the same set Nitro falls through), in the stable order
`GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`, with `HEAD` only when `GET` is a Strata route and `head`
is `derive`, and `OPTIONS` only when `options` is `allow`. A path that matches no pattern is a `404` even
for an unsupported method. Undeclared native routes are unknown to the boundary: their wrong-method request
answers `404` (documented limit); declare them in `nativeRoutes` to get a `405`.

## HEAD policy

`head: "derive"` (default): `HEAD` on a path with a Strata `GET` route runs that route's complete pipeline
once and returns its status and headers with no body. Guards run (a denied `GET` is a denied `HEAD`), the
factory runs once, the one cleanup runs once. A `Response` result's body is released without being read
(a `ReadableStream` with `highWaterMark: 0` is never pulled; a control proves the same route does pull when
a `GET` reads it). Plain values get the content type H3 would give them for JSON and strings. Handlers see
`request.method === "HEAD"`; `route.method` stays `GET`. `HEAD` never maps to `POST`/`PUT`/`PATCH`/`DELETE`.
Not derived for native routes. `head: "off"` makes `HEAD` an ordinary `405`.

Honest limit: deriving `HEAD` executes the `GET` handler, which is the only way to return its real status
and headers. A `GET` handler with expensive side effects should not be exposed through an owned prefix with
`head: "derive"`.

## OPTIONS policy

`options: "off"` (default): `OPTIONS` is an ordinary `405` and is not advertised. `options: "allow"`: a plain
`OPTIONS` on a known path answers `204`, `Allow` (including `OPTIONS`), `Cache-Control: no-store`, no body.
A CORS preflight (`Origin` + `Access-Control-Request-Method`) is never answered: it gets the `405` with an
`Allow` that omits `OPTIONS`, and no `Access-Control-*` header is ever produced. CORS, authentication and
CSRF are not routing: Nitro middleware runs before the router and keeps ownership of preflights. An
`OPTIONS` answer discloses the supported methods of an owned path without authentication, exactly like a
`405` does. Under `vite dev`, Vite's own CORS middleware answers every `OPTIONS` (`Vary: Origin`,
`Access-Control-Allow-Methods`) before Nitro; the boundary never sees it and Strata leaves it untouched, so
the OPTIONS policy is qualified on production builds (Node, workerd) and the dev run asserts only that
Strata does not alter Vite's answer.

## Native Nitro, pages, server functions

- Native routes that handle the method are served by Nitro (`GET /api/health`, the all-method
  `/api/native`, deeper wildcards, `[...].get.ts`-style files). Tested on the real router, the Node
  production server and workerd.
- Analog pages and static assets are outside every owned prefix, and `/apix` / `/api-docs` look-alikes are
  not under `/api`: they stay HTML.
- Analog server functions are dispatched at `/_analog/fn/:id`, outside any prefix a consumer would declare;
  the unit suite registers that dispatch route natively and shows it is untouched. **No real `serverFn`
  module was added to the fixtures**, so server-function end-to-end behaviour is covered only at the
  route-table level. Declaring `/_analog` as an owned prefix is unsupported.
- A native method-less catch-all registered by Nitro for exactly `/<prefix>/**` is replaced by the fallback
  (same router entry, last write wins); method-specific files keep priority.

## Guards and interceptors

The pipeline for a matched route is unchanged: guards → interceptors → factory → handler → interceptor
unwind → awaited cleanup → response. A framework `404`, `405` or `OPTIONS` answer matched no route, so no
guard, interceptor or controller factory runs (asserted with a factory/guard/interceptor spy and, on the
packed consumer, with the guarded controller: `PUT /api/guarded-products/ada-item` is `405` with no
credentials while `DELETE` without credentials is `401`). Boundary-wide authentication belongs in Nitro
middleware; a route guard is never pretended to apply to a route that did not match.

## Standard Schema

`validateParams`, `validateQuery` and `readValidatedJson` are untouched. The boundary never reads a body, so
a malformed body sent to a matched `POST` reaches its handler (400/413/415 unchanged; the existing inventory
checks of `pnpm test:analog` run through the boundary). The 1 MiB limit is unchanged.

## Registration validation (before the router is touched)

Invalid, duplicate or overlapping prefixes; unknown option keys; malformed `head`/`options`/`nativeRoutes`;
a native route outside the prefixes, with unsupported syntax, without methods, with an invalid method or
colliding with a Strata route; a policy change for an already owned prefix; an overlap with an owned prefix
from an earlier call. Every Strata route below an owned prefix (registered earlier or in this batch) must
use static and `:param` segments only, with unique parameter names, and two routes of one method may not
differ only in parameter names (radix3 would serve them from one entry and name the parameter after
whichever registered last). Routes outside owned prefixes keep every previous behaviour, including
wildcards. Existing duplicate detection (method + final path) and the whole-batch atomicity are preserved;
there is no rollback across arbitrary `router.add()` failures and no process-wide registry.

## Evidence

Results of this branch. The classification of the failures seen on PR #112 is in
[Baseline CI investigation](#baseline-ci-investigation).

| Check                                                                                                                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@strata-sc/analog` unit suite (real H3 router with a Nitro-like renderer catch-all)                                                                                | 173 tests pass: 404, 405/Allow, HEAD, OPTIONS, native coexistence, `/_analog/fn/:id`, registration validation, conformance with Nitro's own route choice, negative controls                                                                                                                                                                                                                                |
| `pnpm test:analog`: Analog dev server and Nitro production                                                                                                          | Pass. Dev: JSON 404/405/HEAD, native routes, pages, 24 overlapping requests; `OPTIONS` is Vite's (untouched). Production adds the full `OPTIONS` policy (28 overlapping requests)                                                                                                                                                                                                                          |
| `pnpm test:full-stack-package-consumer`: tarballs installed outside the workspace                                                                                   | Pass: TypeScript 6 and 5.9.2, `skipLibCheck: false`, the example above compiled; Node production and local workerd each run 32 gated overlapping requests plus the hydrated browser probe                                                                                                                                                                                                                  |
| Negative controls (HTML fall-through, wrong content type, 405 for a non-matching path, wrong `Allow`, shadowed native route, `HEAD` with a body, CORS on `OPTIONS`) | Each is detected for its own reason in the shared predicates; the unit suite also proves the no-boundary HTML fall-through and a stream that is pulled by `GET` but not by `HEAD`                                                                                                                                                                                                                          |
| Full local matrix                                                                                                                                                   | Pass, sequential, no deployment: build, lint, typecheck, unit, format, release and performance-tool tests, `test:analog`, package consumer, packed DI consumer, both packed consumers, all `test:server-component-*`, local Cloudflare/workerd, the full-stack Cloudflare rehearsal (no deploy flag or credentials present), website and Relay dogfood, website E2E on a free port, `www:build:cloudflare` |

Not run: `pnpm test:server-components:deployed-cloudflare`, `pnpm test:full-stack-deployed-cloudflare` with
`STRATA_FULLSTACK_DEPLOY=1`, `www:pages:deploy` (they deploy; nothing was deployed or published).

### Performance

Measured in-process through H3 (400 Strata routes under `/api`): a matched route costs the same with and
without the boundary (about 23 µs; the fallback is never reached). Requests that fall through answer in about
5–6 µs (no boundary, HTML) versus 7, 8 and 16 µs (JSON 404 with 10, 100 and 400 routes): a linear scan of the
routes below the prefix, only for requests that matched nothing.

## Baseline CI investigation

PR #112 (run 39740436592) failed two jobs: the Server Component packed consumer and the data-confidentiality
check, so aggregate Verify failed. The push run of the same merge (39747381460) failed the same consumer
again.

- **Symptom:** the Node (and in the push run, workerd) production server answered the page with HTTP 200 but
  an empty `<app-root>`; the log showed `ERROR Error: JIT compiler unavailable` from the page component's
  first render. The same fixtures had passed on PR #111's head.
- **Classification: intermittent baseline failure, not branch-introduced.** The code difference between the
  green #111 head and the failing #112 merge is a version bump and a changelog. It is the already-known
  "unexpected Angular SSR HTTP 200" soft failure, not a Strata regression.
- **Reproduction on main (`b7ab2d6`):** `pnpm test:server-component-security` failed once locally with the
  same empty island, then passed on 4 consecutive runs, including one after deleting the fixture's Vite
  caches. Eight cold-start trials with six concurrent first requests produced no failure. Under this branch's
  complete matrix both affected suites passed.
- **Root cause: not established.** No fix is included and none is claimed. Other recent red runs
  (for example the #110 push) were a separate Ctrl/Cmd-click navigation assertion, not this symptom.
- **Status: REPRODUCED (intermittent), UNRESOLVED.**

## Complete consumer example

Compile-checked from the packed tarballs with strict TypeScript 6 and 5.9.2, `skipLibCheck: false`
([`api-boundary-example.ts`](../../tests/full-stack-package-consumer/fixture/src/check/api-boundary-example.ts)):

```ts
import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import {
  StrataAnalogHttpError,
  jsonResponse,
  noContent,
  registerControllers,
} from "@strata-sc/analog";
import type {
  NitroRouter,
  RegisterControllersOptions,
  StrataAnalogApiBoundaryOptions,
  StrataAnalogGuard,
  StrataAnalogNativeRoute,
  StrataAnalogRequest,
} from "@strata-sc/analog";

const products = new Map([["42", { id: "42", name: "Keyboard" }]]);

@Controller("/api/products")
class ProductsController {
  @Get("/:id")
  find(request: StrataAnalogRequest) {
    const product = products.get(request.params["id"] ?? "");
    if (!product) throw new StrataAnalogHttpError(404, "not_found");
    return jsonResponse(product);
  }

  @Post()
  create() {
    return jsonResponse({ id: "43", name: "Mouse" }, { status: 201 });
  }

  @Patch("/:id")
  update(request: StrataAnalogRequest) {
    return jsonResponse({ id: request.params["id"], name: "Renamed" });
  }

  @Delete("/:id")
  remove() {
    return noContent();
  }
}

@Controller("/api/orders")
class OrdersController {
  @Get()
  list() {
    return [{ id: "o1" }];
  }
}

const requireToken: StrataAnalogGuard = ({ request }) =>
  request.headers.get("authorization")?.startsWith("Bearer ")
    ? { allow: true }
    : { allow: false, status: 401 };

// src/server/routes/api/health.get.ts — a native Nitro route Strata only declares.
const health: StrataAnalogNativeRoute = { path: "/api/health", methods: ["GET"] };

const apiBoundary: StrataAnalogApiBoundaryOptions = {
  prefixes: ["/api"],
  nativeRoutes: [health],
  head: "derive",
  options: "allow",
};

const publicOptions: RegisterControllersOptions = { apiBoundary };

export function registerApi(router: NitroRouter): NitroRouter {
  // The first call declares the owned namespace; later calls only add routes to it.
  registerControllers(router, [OrdersController], publicOptions);

  return registerControllers(router, [ProductsController], { guards: [requireToken] });
}
```

Wired from a Nitro plugin (`src/server/plugins/strata.ts`) and next to a normal Analog page, the behaviour is:

```text
GET     /api/products/42            200 JSON (guard: Bearer token)
GET     /api/products/42/unknown    404 {"error":"not_found"}              application/json, no-store
GET     /api/nonexistent            404 {"error":"not_found"}
TRACE   /api/products/42            405 Allow: GET, HEAD, PATCH, DELETE, OPTIONS   (no guard ran)
HEAD    /api/products/42            200, the GET headers, empty body       (guard ran, handler once)
OPTIONS /api/products/42            204 Allow: GET, HEAD, PATCH, DELETE, OPTIONS, no access-control-*
OPTIONS /api/products/42 + Origin + Access-Control-Request-Method
                                    405 Allow: GET, HEAD, PATCH, DELETE    (preflight never answered)
GET     /api/health                 200 {"status":"ok","source":"nitro"}   (Nitro, not shadowed)
POST    /api/health                 405 Allow: GET, OPTIONS
GET     /about                      200 text/html                          (Analog page, untouched)
```

## Unsupported and open

- No generic router, middleware engine, authentication, OAuth/OIDC, sessions, CSRF or CORS feature.
- No introspection of undeclared native routes; their wrong-method requests answer `404`.
- `HEAD` is not derived for native routes; plain values get best-effort content types and no
  `Content-Length`.
- Path matching for owned prefixes is limited to static and `:param` segments; wildcard Strata routes under
  an owned prefix are rejected, outside it they behave as before.
- `OPTIONS` under `vite dev` is owned by Vite's CORS middleware.
- Angular JIT DI on workerd remains NO-GO; streaming response cleanup, transport cancellation, Server
  Component protocol v3 and SPA subtree hydration are untouched.

## Migration

Nothing changes unless `apiBoundary` is passed. To adopt: list the prefixes, declare native routes you want
accurate `405`s for, move request-wide policy to Nitro middleware, and remove any code that relied on
`/api/*` misses rendering HTML. If a Strata route under the prefix uses a wildcard, split it or move it out of
the owned prefix.
