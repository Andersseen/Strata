# @strata-sc/server-components

> **Experimental.** Version `0.x`, published on npm. The API and the semantics
> described here may change, in any `0.x` release, before 1.0. There is no stability guarantee.
> Public does not mean stable.

Experimental Server Components for Angular and Analog with explicit client boundaries and
server-only graph isolation: a `@ServerComponent()` is rendered on the server, its implementation
never enters the browser graph, and interactivity comes from explicit `[strataClient]` islands that
Angular hydrates over the SSR DOM.

## Install

```bash
pnpm add @strata-sc/server-components
```

(`npm install @strata-sc/server-components` works the same.) Stable releases are on the `latest`
dist-tag; release candidates, when there are any, on `next`.

## Quick start

Add the plugin to the Vite config of an Analog app, **before** `analog()`:

```ts
// vite.config.ts
import analog from "@analogjs/platform";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import { defineConfig } from "vite";

export default defineConfig({
  ssr: { noExternal: ["tslib"] }, // required, see "Consumer setup"
  plugins: [
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components",
    }),
    analog(),
  ],
});
```

`src/generated/server-components` must be listed in the `include` of the app's Angular tsconfig
(`tsconfig.app.json`) and gitignored: the plugin generates the browser surrogates there. The plugin
is on by default; you do not need `enabled: true`.

A Server Component that uses a server-only repository and renders a client island:

```ts
// src/app/product/product.repository.ts
import "@strata-sc/server-components/server-only";

export class ProductRepository {
  find(id: string) {
    return { id, name: `Product ${id}` }; // database access, secrets: never in the browser
  }
}
```

```ts
// src/app/product/product-details.server-component.ts
import { Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { AddToCart } from "./add-to-cart.component";
import { ProductRepository } from "./product.repository";

@ServerComponent()
@Component({
  selector: "product-details",
  imports: [AddToCart, StrataClientBoundary],
  template: `
    <h1>{{ product.name }}</h1>
    <add-to-cart [strataClient]="{ productId: product.id }" />
  `,
})
export class ProductDetails {
  protected readonly product = new ProductRepository().find("42");
}
```

`add-to-cart` is an ordinary Angular component. Because it sits on a `[strataClient]` element it is
the only part sent to the browser; `ProductDetails` and `ProductRepository` stay on the server.
Props are plain data only (see [Client boundary protocol](#client-boundary-protocol)).

The `server-only` import marks a module that must never enter the browser graph: importing it from
a client module, directly or dynamically, or through a `?raw`/`?url` query, fails the production
build with a `[strata]` diagnostic. A barrel that re-exports a marked module becomes server-only
itself. See [Server-only modules](#server-only-modules).

## External Angular package islands

The `@acme/angular-widgets` names below are placeholders; replace them with your installed library's
real public package specifier, component export and input types. A repository-owned test fixture is
not a published consumer dependency.

An installed Angular library component can be used as a client island without copying its source into
the application. Register each selector, package entry point and named export in the Vite plugin:

```ts
strataServerComponents({
  root: import.meta.dirname,
  sourceDir: "src/app",
  generatedDir: "src/generated/server-components",
  clientComponents: [
    {
      selector: "acme-product-picker",
      module: "@acme/angular-widgets",
      exportName: "ProductPickerComponent",
    },
  ],
});
```

Registering a package authorizes that component reference only. It does not exempt the package from
the [server-only contract](#module-resolution-and-packages): a registered package module that
asserts server-only still fails the client build. The plugin also accepts an optional `tsconfig`
(app-relative path of the tsconfig whose `paths` / `baseUrl` it follows when it resolves re-exports;
default `tsconfig.app.json`, then `tsconfig.json`).

The package must expose that named standalone Angular component through its public package exports.
Import the same export into the Server Component's `imports` array and mark the element explicitly:

```ts
import { Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import { ProductPickerComponent } from "@acme/angular-widgets";
import type { ProductView } from "@acme/angular-widgets";
import { ProductRepository } from "./product.repository";

@ServerComponent()
@Component({
  selector: "product-details",
  imports: [ProductPickerComponent, StrataClientBoundary],
  template: `<acme-product-picker
    [productView]="product"
    [strataClient]="{ productView: product }"
  />`,
})
export class ProductDetails {
  private readonly repository = inject(ProductRepository);
  protected readonly product: ProductView = this.repository.publicView("42");
}
```

The registration and named import must match exactly. Import aliases are supported. Unknown,
conflicting, malformed or unregistered references fail before the generated graph is committed. The
surrogate imports only the registered named export from the bare package specifier; Angular's normal
AOT linker processes the package. At runtime Strata reflects the component's public input names and
validates them before assigning props.

Package islands use the existing boundary protocol: flat primitive props remain v1 and structured
plain data uses v2. The example sends only a public `ProductView`; repositories, private fields and the
Server Component implementation stay in the server graph. Never put secrets in boundary props.
Packages are not crawled, and an unmarked package component remains outside the supported composition
contract. The package must be safe for both server rendering and the browser. In dev, edits to an
installed package require restarting Vite; package source files are not watched.

This package-reference path is experimental and qualified only for the dependency tuple and package
shape listed under [Compatibility](#compatibility). It does not promise support for arbitrary Angular
libraries or export-condition layouts.

## Limitations (read these first)

| Area                                                                            | Status                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Document navigation into a Server Component page                                | supported                                                                                                    |
| Buffered SSR (Nitro `node-server`, Cloudflare Pages/workerd)                    | supported                                                                                                    |
| Angular Router navigation into a new Server Component subtree                   | **unsupported** (SPA hydration renders the empty surrogate; use the `/navigation` link, navigator and guard) |
| Streaming SSR                                                                   | **unsupported**                                                                                              |
| Explicitly registered standalone package components as `[strataClient]` islands | **experimental; bounded to the qualified package shape**                                                     |
| `NgComponentOutlet` / dynamic `createComponent` in analysis                     | **unsupported** (invisible to the plugin)                                                                    |
| Content projection into islands                                                 | **not qualified**                                                                                            |
| Request-scoped Server Component context                                         | experimental: Angular `REQUEST_CONTEXT`                                                                      |
| Module-level state shared between the SSR bundle and Nitro code                 | **separate bundles**: each evaluates its own copy                                                            |
| Unexpected Angular render error during SSR                                      | **still HTTP 200** (no supported status bridge); an uncompiled class is stopped at build time instead        |

The full list is under [Experimental restrictions](#experimental-restrictions).

## Compatibility

Qualified (what the repository's gates and the external packed-package consumer actually run):

- Angular core/compiler **22.1.7**, Analog **2.7.2**, Vite **8.3.0**
- TypeScript **5.9.2** and **6.0.3** (declaration consumers)
- Node **22**, Nitro `node-server`, and Cloudflare/workerd (local, via wrangler)

Peer ranges are deliberately tied to that evidence rather than to what might work:
`@angular/core` and `@angular/compiler` `^22.1.7`, `vite` `>=8.3.0 <9`, `typescript`
`^5.9.0 || ^6.0.0`. Older Angular 22.0.x and Vite 8.0–8.2 were never qualified: the hydration path
and the Vite environment-aware `hotUpdate` dev integration have only been tested on the versions above.

## Qualification

- Installed tuple of the latest full run: `@angular/core`, `common`, `compiler` and `router` 22.1.7
  with `@angular/platform-browser` and `platform-server` 22.2.1, Analog 2.7.2, nitropack 2.13.4,
  Vite 8.3.0, TypeScript 6.0.3 (printed by `pnpm test:server-component-security`).
- Node (Nitro `node-server`): `pnpm test:server-components`, `pnpm test:server-component-navigation`.
- Cloudflare Pages, local workerd only: `pnpm test:server-components:cloudflare`.
- Dogfooded by the official website's homepage (`apps/www`), on its Node and Cloudflare Pages
  builds: `pnpm test:www:server-components`.
- Dogfooded by Relay (`apps/relay`): four Server Components (one nested in another, and also
  imported directly by a page), islands side by side and inside `@for`, a Server Component reading
  the Strata controllers' own store, and an incident tree of ordinary server-owned components
  (`IncidentDigestServerComponent` → `IncidentListComponent` → `@for` → `IncidentRowComponent`,
  which injects a server-only service → `IncidentTriageComponent [strataClient]`):
  `pnpm test:relay:server-components`.
- Angular `@defer` / incremental hydration inside client islands, on Node and workerd:
  `pnpm test:server-component-defer`, `pnpm test:server-components:cloudflare`, and Relay's rollout
  island (see [Angular `@defer`](#angular-defer-and-incremental-hydration)).
- Server-only modules (`import "@strata-sc/server-components/server-only"`): direct, dynamic,
  barrel, chained-barrel, `?raw`, `?url` and `@defer`-lazy browser imports fail real production
  builds; marked modules and a synthetic canary stay in the Node and Worker server graphs and out
  of every browser file and source map: `pnpm test:server-component-server-only`,
  `pnpm test:server-components:cloudflare`, and the www and Relay gates (see
  [Server-only modules](#server-only-modules)).
- Server-owned DATA confidentiality (synthetic canaries on HTML, headers, boundary payload,
  hydrated DOM, network, browser output, source maps, production errors and build diagnostics, on
  Node and local workerd): `pnpm test:server-component-security` (see [Security](#security)).
- Dev server (`vite`): graph regeneration, document reload for server-owned edits, the live
  server-only firewall and invalid-edit recovery, against the real Analog dev server in Chromium:
  `pnpm test:server-component-dev` (see [Dev server](#dev-server-vite)).
- **Packed tarball, outside the workspace** (qualified before publication): the package built and packed with `pnpm pack`, installed with `npm install` into a real
  Analog app in an OS temp directory, then production Node build/SSR/hydration/navigation, the
  server-only firewall, `vite` dev with a server-owned edit and a Cloudflare build on local workerd,
  plus declarations under TypeScript 6.0.3 and 5.9.2: `pnpm test:server-component-package-consumer`
  (it also asserts the [production compilation contract](#production-compilation-contract): the gate fails
  two intentionally broken builds for the intended reason, the adversarial environment schedule builds, and
  overlapping first requests to cold servers return complete documents, never an HTTP 200 shell)
  (see [Consumer setup](#consumer-setup)). After each release publishes it,
  `pnpm test:server-component-registry-consumer` installs the exact published version from
  registry.npmjs.org into a fresh app and re-checks resolution, the production build and graph
  split, SSR, protocol v1 and v2, hydration, structured typed input, one interaction and the server-only firewall (the full
  Cloudflare/workerd and dev-server qualification stays with the tarball gate).
- **Document navigation only.** Explicit document navigation into a route containing a server
  component is supported. SPA hydration of a newly rendered server subtree remains unsupported:
  without a consumer-owned fallback it renders the empty surrogate, silently. A consumer may
  protect designated routes with `strataDocumentNavigationGuard` and link to them with
  `StrataDocumentLink` / `StrataDocumentNavigator` from the optional `/navigation` entry. This is a
  full document request, not seamless router integration, and is not a 1.0 qualification.

## Entries

| Import                                     | Contents                                                                                                        | Graph                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `@strata-sc/server-components`             | `ServerComponent`, `StrataClientBoundary`, `ClientBoundaryProps`, `StrataIslandHost`, `provideClientReferences` | server + browser            |
| `@strata-sc/server-components/vite`        | `strataServerComponents(options)`                                                                               | build (Node) only           |
| `@strata-sc/server-components/navigation`  | `StrataDocumentLink`, `StrataDocumentNavigator`, `strataDocumentNavigationGuard`                                | Angular Router + browser    |
| `@strata-sc/server-components/server-only` | nothing: an empty module whose side-effect import is a build-time assertion                                     | server only (never browser) |

The runtime entry imports only `@angular/core`. It is Angular partial-compiled by `ngc` into
`dist/fesm2022/`; Analog 2.7.2's build optimizer runs the Angular linker only on paths matching
`/fesm20/`. The `/vite` entry imports `typescript`, `@angular/compiler` (template parsing), `vite`
types and Node built-ins; nothing in the runtime entry imports it.

### Document navigation

A route whose rendered subtree contains Server Components is reached by a **real document
navigation**: the browser requests a new HTML document, Angular bootstraps and hydrates it. Angular
Router transitions into such a route are unsupported (they render the empty generated surrogate,
silently). The optional `/navigation` entry makes the supported path the easy one. It adds
`@angular/common` and `@angular/router` as peer dependencies and nothing else; it does not replace,
patch or wrap the Angular Router, and it does not discover routes.

| API                             | Use                                                                         |
| ------------------------------- | --------------------------------------------------------------------------- |
| `StrataDocumentLink`            | `<a [strataDocumentLink]="…">`: a native anchor with a computed `href`      |
| `StrataDocumentNavigator`       | `navigate()` / `resolve()`: programmatic document navigation                |
| `strataDocumentNavigationGuard` | Route guard: cancels a later Router activation and retries it as a document |

**Link.** The directive only sets `href`; it never intercepts a click, so history, Cmd/Ctrl-click,
middle-click, `target`, keyboard activation and fragments are the browser's own.

```ts
import { StrataDocumentLink } from "@strata-sc/server-components/navigation";

@Component({
  imports: [StrataDocumentLink],
  template: `<a
    [strataDocumentLink]="['/products', product.id]"
    [queryParams]="{ tab: 'variants' }"
    fragment="details"
    >View product</a
  >`,
})
export class ProductsPage {}
```

The destination is route commands, a `UrlTree` or a root-relative string (`'/products/42?tab=v#d'`).
`null`/`undefined` renders no `href`. Commands resolve with Angular's `Router.createUrlTree`
(relative to the injected `ActivatedRoute` unless `[relativeTo]` is set), are serialized with the
application's `UrlSerializer`, and are prefixed with the base href through `Location`; segments are
percent-encoded by Angular. The `href` is rendered during SSR. Anything that is not a same-origin
path (`https:`, `//host`, `javascript:`, `data:`, a relative string, control characters, a base href
on another origin) throws `StrataDocumentNavigationError` with an actionable message that never
echoes query parameters. Use a plain `<a href>` for external URLs. Combining `strataDocumentLink`
with `routerLink` on one anchor throws.

**Programmatic navigation.**

```ts
const navigator = inject(StrataDocumentNavigator);

navigator.navigate(["/products", id], { queryParams: { tab: "variants" }, fragment: "details" });
```

`navigate()` resolves the destination exactly like the link, checks the origin against the current
document, and calls `Location.assign` (or `replace` with `{ replace: true }`). It returns `true` when
a navigation was started, and `false` when nothing was: during SSR (it never throws there), when the
destination is the current URL, or when the same navigation is already in flight. It never calls
`Router.navigate()`. `resolve()` returns the document URL in any platform. State lives in the
injector, not in a global.

**Guard.** Unchanged for consumers; keep it on every route that renders a Server Component:

```ts
import { defineRouteMeta } from "@analogjs/router";
import { strataDocumentNavigationGuard } from "@strata-sc/server-components/navigation";

export const routeMeta = defineRouteMeta({
  canActivate: [strataDocumentNavigationGuard],
});
```

SSR and the browser's initial navigation render and hydrate normally. Any later Router activation is
cancelled in `canActivate`, before the route component (and its empty surrogate) is created, and
retried as a document navigation to the same path, query and fragment, under the base href. A
navigation to the URL already shown is cancelled without a request, so the guard cannot loop. A
target that cannot be resolved to a same-origin path is cancelled and not retried. Limits: the guard
protects only routes that opt in; a Router transition into an unguarded Server Component route still
renders the empty surrogate (a negative control in the test suite pins this); a popstate to a guarded
entry is retried as a document navigation, which is not seamless.

**Migrating.** A plain `<a href="/products/42">` stays valid and is still the right choice for
external or non-root-relative URLs. Replace `routerLink` on links into Server Component routes with
`strataDocumentLink` (same commands, `queryParams` and `fragment`); replace `router.navigate(...)`
with `StrataDocumentNavigator.navigate(...)`. Keep the guard as the safety net for any remaining
`routerLink`. This is not SPA navigation: every hop is a full document request.

## Use

### Request context (experimental)

Angular's public `REQUEST_CONTEXT` token is available inside a Server Component,
its nested server-owned components and server-only services during buffered SSR.
The application provides the immutable value per render through Analog's public
`render(..., platformProviders)` argument:

```ts
import { REQUEST_CONTEXT, inject } from "@angular/core";

const context = inject(REQUEST_CONTEXT, { optional: true });
```

The optional result is `null` outside SSR or when the host did not provide a
context. The value is server-owned: do not pass confidential fields through
`[strataClient]` or render them into HTML. This is an experimental request
context mechanism, not authentication, authorization, sessions or tenant
isolation. It is qualified only for buffered document SSR; Angular Router
navigation and streaming remain unsupported.

```ts
// vite.config.ts
strataServerComponents({
  root: import.meta.dirname,
  sourceDir: "src/app",
  generatedDir: "src/generated/server-components", // in the Angular program, gitignored
  enabled: true, // optional (default true): shown for the plain-SSR control only, set false there
});
```

```ts
@ServerComponent()
@Component({
  selector: "order-summary",
  imports: [QuantityPicker, StrataClientBoundary],
  template: `<quantity-picker [strataClient]="{ max: 3 }" />`,
})
export class OrderSummary {}
```

- `ServerComponent()` is a marker. It does nothing at runtime.
- In Vite's `client` environment only, the plugin replaces the module with a surrogate generated
  into the app's `generatedDir`: same selector, empty template, `StrataIslandHost`, and the
  client references imported from the app's own modules. Every other environment (SSR, Nitro,
  Worker) keeps the real module. If the real module reaches the `client` environment by another
  path (a query import such as `?raw`, a glob import), the build fails (see
  [Server-only modules](#server-only-modules)).
- `StrataClientBoundary` props are plain data only, validated at runtime: see
  [Client boundary protocol](#client-boundary-protocol).
- `StrataIslandHost` hydrates each boundary as its own root from its `ngh` annotation and destroys
  those `ComponentRef`s when the host is destroyed.

## Consumer setup

The configuration the packed-tarball gate
(`pnpm test:server-component-package-consumer`, `tests/server-component-package-consumer/fixture`)
installs and builds outside the workspace.

```ts
// vite.config.ts — a stock create-analog app plus the Strata plugin
import analog from "@analogjs/platform";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import { defineConfig } from "vite";

export default defineConfig({
  ssr: { noExternal: ["tslib"] }, // required: see below
  plugins: [
    // Before analog(): the surrogates must be in the Angular program when Analog reads its tsconfig.
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components", // in tsconfig.app.json `include`, gitignored
    }),
    analog(),
  ],
});
```

- Peers: `@angular/core` and `@angular/compiler` `^22.1.7`, `typescript` `^5.9.0 || ^6.0.0`, `vite`
  `>=8.3.0 <9` (see [Compatibility](#compatibility)). The optional `/navigation` entry additionally
  uses `@angular/common` and `@angular/router` `^22.1.7`. The package has no dependencies of its own
  and the emitted code imports no `tslib`.
- `ssr.noExternal: ["tslib"]` is an Analog/Nitro requirement, not the package's: `@ServerComponent()`
  makes TypeScript emit `__decorate` through `importHelpers`, and Nitro would otherwise trace
  `tslib.es6.mjs` while Node resolves `modules/index.js`.
- Using Angular `@defer`? Also define `ngServerMode: "true"` in `environments.ssr.define` (see
  [Angular `@defer`](#angular-defer-and-incremental-hydration)). Only for apps on the qualified
  `@defer` path; not needed otherwise.
- The plugin itself adds `optimizeDeps.include` (dev) and `ssr.noExternal` for the runtime package:
  installed from `node_modules` (not linked), Vite would externalize the partial-compiled runtime for
  Node SSR and Angular would fall back to the JIT compiler, which is not loaded.
- `src/generated/server-components` must be in the Angular tsconfig `include` and gitignored.
- Cloudflare Pages: `BUILD_PRESET=cloudflare-pages vite build`, as for the in-repo gates.
- `enabled` is optional and defaults to `true`, so a config that forgets it cannot silently ship Server
  Component implementations to the browser. Only `enabled: false` is the plain-SSR control build.

## Production compilation contract

A production build must leave every Angular class AOT-compiled. A class that reaches the server with its
decorator still applied is compiled by Angular's JIT compiler on first use, which a production server does not
carry (`JIT compiler unavailable`, logged while the response is still HTTP 200 with the component missing) and
which Workers refuse outright. Angular and Analog swallow such a render error, and Strata has no supported way to
turn it into an error response, so the failure is stopped at build time instead:

- In a `vite build`, after every other transform, the plugin fails the build when a **source-owned** module still
  applies `@Component`, `@Directive`, `@Pipe`, `@Injectable` or `@NgModule` (it names the module, the
  environment and the class), or when a **bundled package** still calls an Angular partial declaration
  (`ɵɵngDeclare*`) the Angular linker should have replaced. The diagnostic carries app-relative paths and no source
  text. It does not run under `vite` (dev).
- Analog builds the `client` and `ssr` environments concurrently with one shared Angular plugin that releases its
  compilation output when the first environment finishes. This plugin holds each environment at `buildEnd` until
  every environment of the build has finished transforming, so that release cannot starve a slower environment.
  This is a mitigation of observed upstream behaviour built on public Rollup hooks, not a claim about Analog.

The gate covers modules that pass through Vite. Third-party Angular packages that Nitro traces into its server
output without Vite bundling them are not checked (they are not evaluated unless imported), and a production build
with Analog's `jit: true` option is outside this contract. See
[the evidence](https://github.com/Andersseen/Strata/blob/main/docs/research/server-component-ssr-integrity-v07.md).

## Client boundary protocol

Preview protocols, versions 1 and 2. **Not stable.** The authoring API is unchanged:
`[strataClient]="{ someInput: value }"`. Flat primitive props keep protocol v1; any nested object
or array selects protocol v2.

**Props are public browser data.** Everything placed in `[strataClient]` is written into the HTML
and readable by anyone who loads the page. Serialization is not a security boundary, and Strata
cannot tell whether a string is a secret: `[strataClient]="{ token: internalSecret }"` leaks it, by
the developer's explicit choice. There is no name-based heuristic.

The useful pattern is an explicit public view model, reduced from server data:

```ts
interface ProductVariant {
  readonly id: string;
  readonly label: string;
  readonly stock: number;
}
interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly ProductVariant[];
}

// On the server, omit repository fields such as credentials and provenance.
protected readonly publicProduct: ProductView = {
  id: product.id,
  name: product.name,
  variants: product.variants.map(({ id, label, stock }) => ({ id, label, stock })),
};
```

```html
<product-picker [product]="publicProduct" [strataClient]="{ product: publicProduct }" />
```

The island can receive the same typed readonly model through its public Angular input:

```ts
readonly product = input.required<ProductView>();
```

What Strata does guarantee is that nothing crosses _implicitly_. The server validates and snapshots
the props at runtime, so a cast (`as unknown as ClientBoundaryProps`) or dynamic value cannot carry a
service, repository, class instance, function, closure or signal across. Reduce server values to an
explicit readonly public view model first.

### Server: validate, then serialize

| Rule        | Contract                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape       | Root and nested objects must have `Object.prototype` or `null`, with own enumerable string-keyed data properties. Getters never run; accessors, symbols and non-enumerable properties fail.                                 |
| Values      | Strings, booleans, null and finite numbers; dense arrays and plain objects recursively combine those values. `NaN` and infinities fail.                                                                                     |
| Rejected    | `undefined`, `BigInt`, functions/closures/signals, symbols, class instances, services, `Date`, `Map`, `Set`, `RegExp`, `Promise`, custom prototypes, cycles, sparse arrays, custom array properties and custom serializers. |
| Keys        | `__proto__`, `prototype` and `constructor` fail at every depth.                                                                                                                                                             |
| Limits      | 64 root props; depth 8; 512 values; arrays of at most 128 items; objects of at most 64 keys; 64 KiB (65 536) UTF-8 bytes of serialized JSON.                                                                                |
| Determinism | JSON of a validated independent snapshot in own-property order. Keys are not sorted.                                                                                                                                        |
| Fidelity    | Values round-trip exactly, except `-0`, which JSON writes as `0`.                                                                                                                                                           |

A violation throws a sanitized `StrataBoundaryError`; reflective proxy failures are also rejected
with a generic message. Nothing is dropped, coerced or copied from caller objects. Rejected values
and custom conversion methods are never printed or invoked.

```
[strata] Cannot serialize client boundary <relay-widget>: prop "product.variants[2].stock": undefined is not supported.
Allowed values: string | finite number | boolean | null | dense arrays | plain objects; maximum depth 8, …
```

Angular reports an error thrown by a template binding to its `ErrorHandler` and still completes the
render. So the SSR log carries the Strata error and the invalid value never reaches the HTML (the
host gets no `data-strata-props`), but the HTTP status stays whatever Angular/Analog return (200 in
the fixture). The browser then refuses that host (missing props). No public Angular seam lets a
directive fail the response; an application that wants a 5xx must make its own `ErrorHandler`
rethrow.

The props become host attribute bindings, so Angular's DOM serializer owns the escaping. There is no
`innerHTML`, `<script>` JSON blob or manual string concatenation into HTML. The fixture proves that
`" ' < > &`, `</script><script>globalThis.__STRATA_XSS__=1</script>`, U+2028, U+2029, emoji and
non-Latin text stay inside the attribute and reach the island exactly.

### SSR host markup

```html
<quantity-picker
  data-strata-client="quantity-picker"
  data-strata-protocol="1"
  data-strata-props='{"max":3}'
  data-strata-build="rel-2026.10.2"
  ngh="0"
></quantity-picker>
```

Each attribute has one job: `data-strata-client` holds the host's own selector,
`data-strata-protocol` the protocol version, and `data-strata-props` the props (always written, `{}`
included). Version 1 is used for flat primitive data; version 2 is used when any nested object or
array is present. The version is not wrapped in an envelope inside the props. `data-strata-build`
exists only when the app sets the [`buildId`](#deployment-compatibility) option; an old runtime ignores
it, and the protocol number does not change.

**Identity is the host element.** A boundary is the concrete SSR host element that carries those
three attributes and Angular's `ngh` annotation together. Its props belong to that host. There is no
global payload (`window.__STRATA_DATA__`, `script[type=application/json]`, a central map), no
boundary id, and no server counter, which concurrent requests, separate SSR/Nitro graphs and
workerd isolates would make unsound. Islands are never matched by selector or payload equality: two
boundaries with the same selector and identical props are two hosts, two `ComponentRef`s, with
independent state.

### Browser: preflight all, then commit

Per Server Component host, `StrataIslandHost` hydrates all boundaries or none:

1. **Discover** every element under the host that has any of the three attributes (minus those
   nested in another boundary), so a partial boundary is still checked.
2. **Validate all** of them before creating anything. Each must have `data-strata-protocol` equal to
   `"1"` or `"2"`. A missing protocol is incompatible (it is not read as version 1), and an unknown
   protocol is refused without parsing its props. V1 accepts flat primitives only; v2 requires a
   nested object/array shape. `data-strata-props` must be present, within the size limit, valid JSON,
   and pass the same recursive value contract as on the server. `data-strata-client` must equal
   the host's `localName` and the client reference's selector. Every prop must be a public input
   name of that component, read from `reflectComponentType(type).inputs` (`templateName`, so input
   aliases are honoured; the property name of an aliased input is refused with a hint).
3. **Commit**: `createComponent` on each host, `setInput` per validated entry (the parsed object is
   never merged into anything), `attachView`. Then each host gets `data-strata-hydrated`.

A preflight failure throws one `StrataBoundaryError` naming the boundary, its position and the
reason, before any `ComponentRef` exists. That covers version skew, invalid JSON, a missing
protocol or props attribute, a reserved key, an unsupported value, an unknown input and a selector
mismatch. The server-rendered DOM stays in place, inert. There is no client-side re-render, CSR
fallback or reload. A reload strategy is not defined yet. The error reaches the application's
`ErrorHandler` once; see [Failure and recovery](#failure-and-recovery).

| Server markup                | Browser runtime   | Result                                                                       |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| Old v1 server                | New v1/v2 browser | V1 payload is accepted.                                                      |
| New server, flat props       | Old v1 browser    | V1 payload remains compatible.                                               |
| New server, structured props | New v1/v2 browser | V2 is recursively validated and hydrated.                                    |
| New server, structured props | Old v1 browser    | V2 is an unknown version; old runtime fails closed and leaves SSR DOM inert. |
| Missing or unknown version   | Any runtime       | No fallback; hydration is refused.                                           |

Mixed v1 and v2 boundaries are validated on their own SSR hosts. A malformed boundary still fails
the existing all-or-nothing preflight for its owning Server Component host. This does not provide
seamless rolling deployment when older browser assets are paired with v2 server markup.

If `createComponent` or `setInput` fails during commit, the islands this commit already created are
destroyed (which also detaches their views from the `ApplicationRef`), their SSR host elements,
which Angular detaches on destroy, are put back in place, and the error propagates. Host destroy
destroys every island it created.

Required inputs: `reflectComponentType` exposes no `required` flag, and Strata uses no `ɵ` API. So
required-input completeness stays Angular-owned when the component is created: a required signal
input that was never set throws Angular's NG0950 when it is read.

Evidence: unit tests in `src/runtime/boundary-protocol.test.ts` and `src/runtime/hydration-plan.test.ts`.
The Analog fixture route `/server-component-boundaries` runs the positive path on Node and workerd,
and on Node the tampered-markup, rollback and invalid-SSR paths too (`pnpm test:server-components`,
`pnpm test:server-components:cloudflare`).

## Composition

Within a Server Component subtree:

- **Unmarked local Angular components remain server-owned.** An ordinary child, grandchild (any
  depth) or nested `@ServerComponent()` renders on the server only; neither it nor anything it
  imports or injects reaches the browser through the Server Component.
- **`[strataClient]` is the only browser boundary.** Its component, and only its component's own
  graph, enters the browser.

```ts
@ServerComponent()
@Component({ selector: "order-page", imports: [OrderDetails], template: `<order-details />` })
export class OrderPage {}

@Component({
  selector: "order-details", // ordinary: no decorator, server-owned through composition
  imports: [QuantityPicker, StrataClientBoundary],
  template: `<h2>{{ order.name }}</h2>
    <quantity-picker [strataClient]="{ quantity: order.quantity }" />`,
})
export class OrderDetails {}
```

Browser graph: `QuantityPicker` only. The plugin walks the Server Component's template; at each
element it resolves a local component through the _owning_ component's own `imports` (no global
registry). An element marked `[strataClient]` becomes a client reference and the walk stops
there: the client component's template is never inspected. An unmarked local component is walked
recursively, inside `@if`, `@for`, `@switch`, `@empty` and `@let` alike, from an inline `template`
or a relative `templateUrl`. The outer Server Component's surrogate owns every client reference
found below it, once each, in first-encounter order; `StrataIslandHost` already hydrates every
descendant boundary. A nested Server Component keeps its own surrogate, so importing it directly
from an ordinary page still works.

**Interactive bindings in server-owned templates fail the build**, because that code never runs in
the browser: `(click)`, `(submit)`, `(keydown.enter)`, `(window:resize)`, a custom output such as
`(quantityChanged)`, an output of a `[strataClient]` element handled by its server-owned parent,
two-way `[(ngModel)]`, and `host: { "(…)": … }` or `@HostListener` on a server-owned component or
a local directive it imports. The message names the file, line and column, the component and the
composition path, and points to `[strataClient]`. Rendering-only features stay valid: pipes,
interpolation, property/attribute/class/style bindings (`[value]` is not `(valueChange)`), and
control flow. Event handlers inside a `[strataClient]` component are its own and are never
inspected.

The build also fails on a composition cycle (the message lists the component path), on two local
imports declaring the same element selector, on two different client components hydrating as the
same element under one Server Component, on a `[strataClient]` element that resolves to no local
component, and on a `@ServerComponent()` marked `[strataClient]`.

Recursive analysis qualifies **local application components only**: declared in an app module
imported by a relative specifier. Package components (`@voltui/components`, …) are opaque: never
crawled, never client references; an event binding on their element in a server-owned template
still fails. Not supported, and failing the build: re-exports and barrels, local `NgModule`s,
composed components without a single custom element selector, and computed templates.

## Angular `@defer` and incremental hydration

Strata Server Components coexist with Angular incremental hydration inside explicit client
boundaries. Strata implements no defer scheduler, trigger or event replay. Two layers:

1. **Strata** hydrates each `[strataClient]` root when its Server Component host renders, after
   the protocol v1/v2 preflight. That is unchanged: the root is not hydrated lazily.
2. **Angular** owns every `@defer` block in that client component's own template: SSR main
   content, dehydrated until its hydrate trigger, its dependencies in a lazy chunk, event replay.

| Shape                                                                | Status      | Owner   | Evidence                                                                                                  |
| -------------------------------------------------------------------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `@defer` in a `[strataClient]` component's own template              | supported   | Angular | never inspected by the analyzer                                                                           |
| `hydrate on interaction` in a client island                          | supported   | Angular | lazy chunk only on the click; one click, one effect (replay); SSR DOM reused. Node, workerd, Relay        |
| `hydrate on viewport` in a client island                             | supported   | Angular | lazy chunk only when scrolled into view; SSR DOM reused. Node, workerd                                    |
| island with `@defer` under a server-owned child (nested composition) | supported   | Angular | parent and child absent from the browser; island eager; widget lazy                                       |
| `@defer` in a server-owned template (any trigger)                    | build error | —       | placeholder rendered and never replaceable, or hydrate triggers that can never complete                   |
| `[strataClient]` inside a server-owned `@defer`                      | build error | —       | measured: Strata hydrated the island on load, violating `hydrate on interaction`                          |
| `hydrate never` in a server-owned template, server-only content      | build error | —       | static only if SSR honours `hydrate never`; under Analog 2.7.2's default build it renders the placeholder |
| `hydrate never` around a `[strataClient]`                            | build error | —       | measured: no `ngh` written, Strata hydrated it anyway, rendered twice                                     |

Server-owned means the Server Component's template, and the template of every unmarked local
component it renders (any depth, nested Server Components included). The owner is absent from the
browser graph, so no browser code could run the block. The diagnostic names the file, line, column
and component path, gives the shape's reason, and points to `[strataClient]`:

```
src/app/orders/order-page.ts:12:5: @defer block in server-only component OrderDetails (rendered by
OrderPage → OrderDetails). The owning component is absent from the browser graph, so Angular cannot
run this defer block client-side. It contains the client boundary <quantity-picker>. Strata hydrates
every client boundary under a Server Component when the page loads, so this block's triggers
(hydrate on interaction) would not be honoured. Move the deferred behaviour inside a component
marked [strataClient] (its own template may use @defer and hydrate triggers, which Angular owns),
or render the server content directly.
```

Use `provideClientHydration()` alone: Angular 22 enables incremental hydration and event replay by
default. **Analog 2.7.2 needs one Vite setting** for any `@defer (hydrate …)` to render its main
content in SSR, because its production build defines `ngServerMode` as `false` for the SSR graph
too:

```ts
// vite.config.ts
environments: { ssr: { define: { ngServerMode: "true" } } },
```

Without it, SSR renders the placeholder and runs `on viewport` on the server. Details, the measured
unsupported shapes and limitations: `docs/research/server-component-defer-poc.md`.

## Server-only modules

```ts
// src/app/catalog/product.repository.ts
import "@strata-sc/server-components/server-only";

export class ProductRepository {
  // database access, credentials, SDK clients …
}
```

- **An explicit build-time assertion.** The side-effect import declares: _this module must never
  enter a browser graph_. It is not a decorator, a function call or a runtime registry. The entry
  is empty (no imports, no code), so it is safe in Node SSR and workerd and costs nothing at run
  time; the plugin enforces it during the build.
- **A marked module cannot enter the `client` environment.** Resolving it there fails the build
  before any browser output is written, whatever the import shape: a direct import, a dynamic
  `import()` (including inside a client component's own `@defer` lazy code), or a query import
  (`?raw`, `?url`, …: the query is stripped and the underlying module is checked, because a source
  string is a disclosure too). A `load` backstop rejects one reached without resolution (e.g. a glob
  import). Server environments (SSR, Nitro, Worker) are never restricted: a Server Component and the
  server-owned code it renders may import marked modules freely.
- **`@ServerComponent()` modules are already protected automatically.** They do not need the
  assertion; in the browser they are only ever replaced by their surrogate, and a query import or an
  unresolved path to one fails the build with the same diagnostic shape.
- **Re-export barrels inherit the restriction.** A module that re-exports a marked module
  (`export * from`, `export { X } from`, `export * as X from`), directly or through a chain of
  barrels, is server-only for the browser too, even when the browser only wanted another of its
  exports. The re-export is followed through relative paths, `index` files, `.js` → `.ts`
  specifiers, Vite `resolve.alias` and the app's tsconfig `paths` / `baseUrl`. Re-export cycles are
  handled. `export type { … } from` loads nothing and does not propagate.
- **Ordinary imports do not propagate.** A marked repository importing `./shared-format` does not
  make `shared-format` server-only, so shared modules remain possible: a client island may import
  the same `shared-format`. A dependency that is itself sensitive (a secret loader, a database
  client) must carry the assertion itself. There is no directory, file-name or secret-name
  heuristic.

The pre-scan runs when the plugin is configured: it parses every TypeScript module under
`sourceDir` with the TypeScript AST (comments and strings that merely contain the specifier do not
count), records the assertions and the re-export edges it can resolve to a scanned module, and
propagates the restriction upward through re-exports to a fixpoint. The set is rebuilt for every
build and, in dev, for every source edit that can change it.

```
[strata] Server-only module entered the browser graph: src/app/server-component/product-repository.ts
Imported from: src/app/catalog/product-widget.component.ts
Reason: the module declares `import "@strata-sc/server-components/server-only";`.
Move the dependency behind the Server Component boundary (use it only from a @ServerComponent() or
the server-owned components it renders, and pass plain data to the island through [strataClient]),
or remove the browser import.
Import chain (the bundler's first importer at each step): src/main.ts → … → src/app/catalog/product-widget.component.ts
```

A barrel names the chain instead: `Reason: it re-exports a server-only module: src/app/server/index.ts
→ src/app/server/product.repository.ts, which declares …`. Paths are app-relative; a dependency
prints from its last `node_modules/` segment; a file outside the app prints only its name. The import
chain is what the bundler reported and ends where it knows nothing more; when it reports no importer
the diagnostic says `unavailable` instead of naming one.

### Module resolution and packages

| Import written in an app module                                     | Followed when scanning re-exports |   Refused in the browser graph   |
| ------------------------------------------------------------------- | :-------------------------------: | :------------------------------: |
| `./x`, `../x`, `./dir` (index), `./x.js` → `./x.ts`, `?raw`, `?url` |                yes                |               yes                |
| Vite `resolve.alias` (`~app/x`, `@/x`)                              |                yes                |               yes                |
| tsconfig `paths` / `baseUrl` (`@app/x`)                             |                yes                |               yes                |
| `import()`, `@defer` lazy chunks                                    |                n/a                |               yes                |
| Package root or exported subpath                                    |        no (never crawled)         | yes, when it asserts server-only |
| `import.meta.glob`, import-then-`export { X }`                      |                no                 |         yes (load time)          |

Aliases are read from Vite's resolved config; the tsconfig is `tsconfig.app.json`, else
`tsconfig.json`, in the app root (or the optional `tsconfig` plugin option, app-relative). **A module
the pre-scan cannot see is not exempt:** the client environment checks the resolved identity of every
module it resolves or loads, so an unmodelled resolution form is still refused at build or load time;
only its diagnostic is less specific.

A package is never trusted by name. If an installed or linked package module (a package root, a
subpath, a barrel) imports `@strata-sc/server-components/server-only`, the client build fails when
that import is resolved, whether or not the package appears in `clientComponents`: the registry
authorizes an Angular component reference, not a server-only dependency. A browser-safe package root
or subpath builds and ships normally. Under the dev server's pre-bundled dependencies the importer
inside a package is collapsed into a chunk, so the diagnostic there can name the package module but
not its internal importer.

Recipe (server-only repository → Server Component → public DTO → island): see
[Server-only recipe](#server-only-recipe).

### Server-only recipe

```ts
// src/app/catalog/product.dto.ts (shared and browser-safe: types and plain values only)
export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly stock: number;
}
```

```ts
// src/app/catalog/product.repository.ts (explicitly server-only)
import "@strata-sc/server-components/server-only";
import type { ProductView } from "~app/catalog/product.dto";

export class ProductRepository {
  findPublic(id: string): ProductView {
    // database access, credentials, SDK clients … stay here
    return { id, name: "Product", stock: 3 };
  }
}
```

```ts
// src/app/catalog/product.server-component.ts: the repository is legal on the server side
@ServerComponent()
@Component({
  selector: "product-card",
  imports: [AddToCartComponent, StrataClientBoundary],
  template: `<add-to-cart [strataClient]="{ product: product }" />`,
})
export class ProductCardServerComponent {
  protected readonly product = inject(ProductRepository).findPublic("42");
}
```

The island (`AddToCartComponent`) may import `ProductView` through any alias; it must not import the
repository, directly or through a barrel, and the build rejects it if it does:

```ts
import { ProductRepository } from "@app/catalog"; // fails the client build, naming src/app/catalog/index.ts
```

Rejected shapes and their diagnostics are exercised against real production builds by
`pnpm test:server-component-server-only` (Analog fixture) and
`pnpm test:server-component-package-consumer` (packed tarball in an npm project).

Limits of this preview: only the root tsconfig file is watched in dev (a change in an extended file
needs a server restart); a Vite alias change is a `vite.config.ts` change and restarts Vite; the
Server Component analyzer still resolves component imports relatively only; a package that exposes
data without asserting server-only is not detected (packages are not crawled); and
`@analogjs/vite-plugin-angular` can keep a stale compile of a module that left its TypeScript
program. Under `vite` the scan runs again after every source edit (see [Dev server](#dev-server-vite)).
Checked by `pnpm test:server-component-server-only` (real production builds),
`pnpm test:server-component-dev` (live edits) and unit tests.

## Dev server (`vite`)

The graph is derived at `config()`, before Analog reads its tsconfig, exactly as in a build. Under
`vite` it is derived **again** after every source edit that can change it, so the generated
surrogates, the server-only set and the set of server-owned files never go stale. There is no
option for this: it is on whenever the plugin is `enabled`.

```
SERVER-OWNED CHANGE   →  regenerate the graph  →  ONE document reload  →  fresh SSR  →  islands hydrate
CLIENT-OWNED CHANGE   →  graph unchanged       →  the framework's own update path (Vite / Angular)
INVALID GRAPH EDIT    →  Strata diagnostic     →  the client graph fails closed
FIX                   →  graph regenerates     →  reload, no restart of Vite
```

**Why a Server Component edit reloads the document.** A Server Component's implementation is
deliberately absent from the browser graph: the browser only has its generated surrogate, an empty
component. There is nothing in the browser to hot-patch, so the only way to show the new
implementation is to render it again on the server, which is a new document. That is the dev
contract, not a fallback. Strata does not ship a Server Component HMR protocol, an HTML fragment
patcher or a client HMR runtime; the reload goes through Vite's own `full-reload` message.

What counts as server-owned (an edit reloads, even when no surrogate changes):

- the `@ServerComponent()` module, and every local component, directive and pipe it renders
  without `[strataClient]`, at any depth (nested Server Components included);
- their `templateUrl` files;
- a module that asserts `import "@strata-sc/server-components/server-only"` (or re-exports one).

A client island edit (its template, logic, styles) that leaves every surrogate and the server-only
set identical is **not** reloaded by Strata. What the framework does with it is the framework's:
under Analog's default (`liveReload: false`) Vite reloads the page for any Angular TypeScript edit;
with `liveReload: true` Angular's component HMR updates the island in place (same realm, state
kept). An edit that changes the graph (a boundary added, removed or swapped; a module becoming
server-only) is graph-changing wherever it was made, and reloads.

How it works, all through Vite 8's public API:

- **`hotUpdate`** (environment-aware; it also sees file creation and deletion, which
  `handleHotUpdate` does not). One watcher event is shared by every environment it visits: the
  graph is refreshed once, in the `client` environment's call, and the reload is sent once, from
  the last environment's call.
- **Transactional refresh.** Every source is read once, the whole next graph is analyzed in memory,
  and only if that succeeds are the generated files synchronized and the graph swapped in. An
  analysis error leaves the committed graph and the generated files exactly as they were.
- **Generated files** are synchronized, not recreated: an identical surrogate is not rewritten (no
  watcher event, no HMR churn), a changed one is, a surrogate whose Server Component is gone is
  deleted. The plugin ignores events from `generatedDir`, so its own writes never loop.
- **Order.** Regenerate, commit, invalidate the `client` environment's cached modules for the
  changed surrogates and for every module whose forbidden status flipped, and only then reload; when
  a surrogate was written, the reload waits for the watcher to report it (so Angular has compiled
  it), with a two-second fallback.
- **Fail closed.** While the sources cannot be analyzed into a graph, the committed server-only
  set is not trusted: the `client` environment refuses every module of the app (`sourceDir` and
  `generatedDir`) with the analyzer's own diagnostic, Vite's cached transforms are dropped so the
  refusal cannot be bypassed, and the diagnostic is logged and sent to Vite's error overlay. The
  next successful refresh reopens the graph and reloads the document.

```
[strata] The Server Component graph could not be refreshed, so the browser graph is closed until it can: …/dev-child.component.ts:12:5: @defer block in server-only component DevChildComponent (…)
```

**Live firewall.** The server-only rules of [Server-only modules](#server-only-modules) hold in dev:
a module that starts asserting server-only (or a barrel that starts re-exporting one) is refused to
the browser on the next request, by import, dynamic `import()`, `?raw` and `?url`, without
restarting Vite. The diagnostic names modules and the reason, never their contents.

**Temporal limit.** Marking a module server-only prevents _future_ browser loads; it cannot revoke
bytes the current page already received and executed. Strata ends that realm with the document
reload; it does not claim retrospective secrecy.

Limits: Strata reads `sourceDir`'s TypeScript and the `templateUrl` files the analysis reaches; a
module that a Server Component imports for its logic but that is neither a component, directive,
pipe nor server-only (a plain helper shared with client code) is not tracked, so editing it follows
the client path while the next server render picks it up. A graph that is invalid when `vite`
starts fails the start, as before. Analog's `liveReload: true` (off by default) keeps its edited
component modules from being re-evaluated in the SSR module runner for any component, with or
without Strata: Server Component dev is qualified with the default only; the `liveReload: true`
run in the gate covers client-island HMR coexistence. The graph refresh costs a few milliseconds
(median 7 ms on the Analog fixture, 4 ms on Relay, 2 ms on the website), a full scan with no
incremental state. Report: `docs/research/server-component-dev-hmr.md`.

## Failure and recovery

Qualified for **buffered SSR + document navigation + `[strataClient]` hydration**, on Nitro `node-server`
and local workerd (`pnpm test:server-component-failures`,
[report](../../docs/research/server-component-failure-recovery.md)). The separate
`pnpm test:server-component-ssr-response` gate qualifies one consumer-owned expected-service
recovery pattern on the same runtimes ([report](../../docs/research/server-component-ssr-response.md)).
The cases below describe the package contract and its failure boundaries:

| Case                          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Server render error**       | Angular and Analog's behaviour, not Strata's. A Server Component that throws while Angular renders it (constructor, injected provider, template) is reported to the server's `ErrorHandler` once. The response is **HTTP 200**: an empty router outlet when construction fails, a half-rendered component (no `data-strata-*` attribute on its boundary host) when a template binding fails. **HTTP 200 plus an empty shell is the current Angular/Analog buffered failure behaviour, not a Strata success response.** The browser then shows the page around an empty component, or the inert half-rendered DOM. No supported Strata seam can turn this into a failed response or a fallback (a global `ErrorHandler` that rethrows would change unrelated errors, so Strata ships none). |
| **Expected service recovery** | Application-owned code may catch a typed, expected repository/domain failure before it reaches Angular, use Analog's public `RESPONSE` token to set an honest status, and render generic fallback HTML. The fixture proves 503 plus `cache-control: no-store` on Node and local workerd. This is not a package API and does not change the unexpected render-error contract.                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Serialization error**       | `[strataClient]` rejects a class instance, nested object, `NaN`, … at SSR: one `StrataBoundaryError` to the server `ErrorHandler`, the value is never written, HTTP 200 with the rest of the component. The boundary host keeps `data-strata-client` and `data-strata-protocol` and has **no** `data-strata-props`; the browser refuses it at preflight.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Boundary preflight**        | Per host, before anything exists: all boundaries valid or none. A failing host is entirely inert (even its valid boundaries), its SSR DOM stays (same nodes), one data-safe `StrataBoundaryError` (boundary position and reason; never props, DOM or payload) goes to `ErrorHandler`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Hydration commit rollback** | `createComponent` / `setInput` throws: every island that host's commit created is destroyed (views detached), the SSR host elements are put back (same objects, same position), no `data-strata-hydrated`, and the component's own error goes to `ErrorHandler` once, unchanged (not relabelled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Sibling-host isolation**    | One Server Component host is one hydration transaction. All-or-nothing is **per host**, not per page: host B failing leaves A and C hydrated and interactive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Errors after hydration**    | After `data-strata-hydrated` an island is an ordinary Angular component. A throwing handler is Angular's and the application's; Strata does not roll back, destroy the host, retry or wrap it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Where errors are reported.** Strata registers no `ErrorHandler` and never replaces yours. A Strata-owned
hydration failure is thrown from the host's `afterNextRender` callback; Angular catches it per callback,
hands it to the application's `ErrorHandler` exactly once and does not rethrow (so Angular's default
handler logs it; it is neither silent nor an unhandled rejection or `window` error). An `ErrorHandler`
that itself throws is your decision.

**Retry.** None. Hydration is attempted once per host lifecycle: no timer, observer, reload or retry.
Destroying the host after a failure is safe and reports nothing more. A new document is a new lifecycle
with one fresh attempt.

**Document navigation.** A plain-anchor navigation into a failing route is a new request and a new
realm with the same server contract; the old page's islands and DOM are gone. Back and re-entry are fresh
lifecycles (observed in Chromium as a new document, `back_forward`; no stale failed-host state, one report
per lifecycle). Angular Router navigation into a Server Component subtree remains unsupported.

**Version skew.** `data-strata-protocol` different from the browser runtime's: that host is inert with
its SSR DOM, one `StrataBoundaryError` (category `protocol`), sibling hosts hydrate. A protocol number
says nothing about the _application_: for a document and a script from different deployments, opt in to
the [build identity](#deployment-compatibility) below. Without it nothing recovers automatically.

**Streaming.** Unsupported and not qualified. Strata Server Components are qualified with buffered SSR
only; Analog's experimental streaming (`experimental.streaming`, `renderStream`) is not, and Strata does
not detect it. No failure-after-headers behaviour is defined.

There is no general `ErrorBoundary`, fallback template, `retry()` or other package recovery API yet.
Expected service recovery is application-owned and must catch only explicitly expected failures;
unexpected Angular render errors remain the HTTP 200 behavior above.

## Deployment compatibility

Server Components are safe across a deployment only when the document and the browser script come from
the same application build. The boundary protocol (`1`/`2`) cannot tell: two different builds can speak
the same protocol while a client component's inputs, implementation or registry have changed. The
opt-in **build identity** closes that gap and nothing more. It is a deployment label chosen by you, not
a package version, not a content fingerprint and not a security boundary; it is public (it is written
into the document) and proves nothing about who produced the markup.

```ts
// vite.config.ts — one value per release, the same for the whole build
strataServerComponents({
  root: import.meta.dirname,
  sourceDir: "src/app",
  generatedDir: "src/generated/server-components",
  buildId: process.env["RELEASE_ID"], // e.g. "rel-2026.10.2": 1–64 chars of A–Z a–z 0–9 . _ : + -
});
```

```ts
// app.config.ts — optional; without it a mismatch is only reported
import { provideSkewRecovery } from "@strata-sc/server-components";

provideSkewRecovery({
  reload: true, // opt in to ONE bounded document reload per tab and window
  onMismatch: ({ browserBuildId, serverBuildId }) => report(browserBuildId, serverBuildId),
});
```

**How both artifacts get the same identity.** `buildId` becomes the compile-time constant
`__STRATA_BUILD_ID__` through Vite `define`, for every environment of that one build (client, `ssr`,
Nitro). There is no runtime lookup, no request state, no global and no generated server module. The
server writes it as `data-strata-build` on each client boundary host; the browser compares it
with its own before creating any `ComponentRef`. Your CI/CD must give **each distinct build its own
value** and must build the client and server artifacts of a release in one `vite build` (or pass the
same value to every part of a split build). Reusing a value for different code defeats the check: a
Git SHA alone is not enough if the same commit is built with different configuration, so combine it
with whatever else varies (`${GIT_SHA}-${CONFIG_HASH}`). It must never be a secret, a credential, a
request or user id.

**What the browser decides, per Server Component host (before anything is created):**

| Situation                                                   | Error (`category`)                                              | Hydrates    | Reload (if opted in) |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ----------- | -------------------- |
| Same identity                                               | none                                                            | yes         | no                   |
| Browser has no identity (option off)                        | none: the attribute is ignored                                  | as before   | no                   |
| Both well-formed, **different**                             | `StrataBuildMismatchError` (`build-mismatch`)                   | no          | **yes, bounded**     |
| Browser has an identity, the host has none                  | `StrataBoundaryError` (`build-identity`)                        | no          | no                   |
| Host attribute empty, too long or not an identifier         | `StrataBoundaryError` (`build-identity`)                        | no          | no                   |
| Identity fine, protocol unsupported                         | `StrataBoundaryError` (`protocol`)                              | no          | no                   |
| Identity fine, bad props / unknown selector / unknown input | `StrataBoundaryError` (`props`/`reference`/`inputs`/`metadata`) | no          | no                   |
| A component constructor or `setInput` throws                | that error, unchanged                                           | rolled back | no                   |

Only a mismatch between two **well-formed** identities is treated as a deployment, and it is checked
first because in a mixed deployment the registry, the inputs and the protocol are exactly what cannot be
trusted to agree. A missing or malformed identity is reported, never acted on. Per-host all-or-nothing,
sibling isolation, rollback and the SSR DOM staying in place are unchanged; the error goes to your
`ErrorHandler` whether or not recovery ran (`error.recovery` says what happened: `disabled`,
`reloading`, `exhausted` or `storage-unavailable`). A diagnostic names the category and the two public
build ids, and never props, markup, paths or secrets.

**Recovery is off unless you ask.** With `provideSkewRecovery({ reload: true })` a confirmed mismatch
calls `location.reload()` of the current document, nothing else: the same URL, never a computed
redirect, no fetch, no patching. Because that replaces the whole document, every healthy island and any
unsaved state in it is lost, which is why it is opt-in. It is bounded by a counter in the tab's
`sessionStorage` (`strata:skew-recovery`: `{count, since}` only; no URL, no build id): by default one
reload per tab per five minutes (`maxReloads` 1–3, `windowSeconds` 30–3600), recorded before the reload
is requested and read back. Several refused hosts schedule one reload. If storage is blocked, does not
persist a write, or holds an implausible value, there is **no** reload (`storage-unavailable` /
`exhausted`) and the page stays in its inert server-rendered state. A reload that lands on the same
mismatch stops: the second document reports `exhausted`. An unrelated user reload inside the window
does not earn another automatic one.

**Deploying without breaking open documents.**

1. Give the release a new `buildId` and publish its hashed assets **before** its documents; keep the
   previous release's assets until old documents have aged out. Hashed asset names (the default) make a
   mixed pair unlikely; a stable entry URL, a cache that holds an old document, or a rolling deployment
   with a shared asset path make it real.
2. A document and its script from different builds: an open tab keeps its old script, and its next
   _document_ navigation is a new document with its own scripts. The check matters when those two
   disagree: it turns "a half-working page" into "an inert, correct server-rendered page, one
   error, and optionally one reload".
3. Rollback is a release like any other: roll back to a build **that was deployed with an identity**
   and keep that release's assets published. A rollback to a pre-identity build leaves open tabs with
   no way to tell (see below).
4. Watch `onMismatch`/the `ErrorHandler` rate during a rollout; a persistent rate means the CDN is not
   converging.

**What it cannot do.** A browser script built **before** `buildId` existed (including every script
already open when you first deploy this feature) does not read the attribute and behaves exactly as it
did: the first deployment cannot repair old clients. A newer document with an old script is not detected
by that old script, and an older document (no stamp) with a new script is refused as `build-identity`.
Reload is a full navigation: there is no partial patch, no service worker, no cross-tab coordination.
The attribute is editable client-side; the worst a tampered value achieves is one bounded reload of the
user's own document per window, no different from the user pressing reload.

Qualification: `pnpm test:server-component-deployment-skew` builds releases A and B (and a no-identity
release) of an external consumer from the packed tarball, serves a document of one with the script of
another, and runs the matrix on Nitro Node and local workerd (not a deployed Pages project). Report:
[docs/research/server-component-deployment-skew-v08.md](../../docs/research/server-component-deployment-skew-v08.md).

## Security

```text
SERVER-OWNED DATA                          [strataClient] DATA
does not cross implicitly.                 is explicitly browser-public.
```

A value a Server Component reads or uses (a repository, a credential, a connection string) does not
reach any public browser surface merely because the Server Component used it. Everything the
developer passes on purpose through `[strataClient]` is public browser data: Strata protects
implicit crossings and cannot know that a primitive string you pass is a business secret.

Three separate mechanisms, each with its own evidence:

- **Server-only import assertion** (module confidentiality). `import
"@strata-sc/server-components/server-only"` makes the build reject any browser import of the
  module ([Server-only modules](#server-only-modules)). This keeps the _module_ out of the browser
  graph; it says nothing about what a server-side module returns.
- **Protocol runtime validation** (boundary confidentiality). `[strataClient]` keeps flat primitive
  props on v1 and uses v2 for bounded nested JSON data. A repository, service, class instance,
  function, signal or other unsupported value that a cast smuggles in is rejected with a
  `StrataBoundaryError` before anything is serialized. Diagnostics can identify a structural path
  and category, but never print the rejected value.
- **Synthetic leak qualification.** `pnpm test:server-component-security` renders a Server
  Component that reads a server-only repository using a synthetic DATA canary and passes a PUBLIC
  control canary through `[strataClient]`. The DATA canary must be absent, in any of its encodings,
  from the raw SSR HTML (comments, inline scripts, `ng-state`, `ngh`, `data-strata-*`), response
  headers, the parsed boundary payload, the hydrated DOM before and after an interaction, every
  public network response, `dist/client` and `dist/analog/public` (including source maps), the
  browser's error surface and the output of a failed illegal-import build. The PUBLIC control must
  be present everywhere it deliberately crosses, and the DATA canary must be present in the server
  graph, so a clean scan cannot be a blind one. The same surfaces run on Nitro `node-server` and on
  local workerd.

Errors. Strata adds no exception filter. In the measured production builds (Node and workerd) a
Server Component that throws a secret-bearing error (plain, `Error.cause`, `AggregateError`) leaves
the public response carrying neither the message nor a stack nor a path: Angular answers HTTP 200
with an empty outlet (or, for a template error, a half-rendered component), exactly pinned in
[Failure and recovery](#failure-and-recovery); the status and log content are Angular's and Analog's. The server's own log does contain the
original error, because that is the operator's surface; redact it in your logging pipeline.

Not covered, and not claimed: production authentication, sessions, authorization APIs, tenant or
cache isolation, origin/CSRF rules, or a general request-scoped data API. A fixture-only synthetic
authorization qualification now exists at
`docs/research/server-component-authorization-isolation.md` and is exercised by
`pnpm test:server-component-authorization`; it does not add a package API or change these limits.
The synthetic `REQUEST_CONTEXT` and service-isolation evidence is recorded in
`docs/research/server-component-request-isolation.md`. The dev server's confidentiality beyond the
live firewall (see [Dev server](#dev-server-vite)), a real deployment, and secrets in logs or
third-party error reporters remain open. This is not a claim of complete application security.
Module-level state shared between Angular SSR and Nitro (`processSingleton` in Relay) is a
domain-state workaround, not request isolation, tenant isolation or a security boundary.

## Experimental restrictions

- One named `@ServerComponent()` class per module, stacked on `@Component({...})`.
- `selector` must be a string literal; `imports` entries must be plain identifiers bound by named
  imports.
- **Client references are explicit.** The plugin parses templates with `@angular/compiler`'s
  `parseTemplate`. Only a component on an element marked `[strataClient]` becomes a client
  reference (see Composition). Every other import (a server-only child component, a pipe, a
  directive, anything from a package) stays in the server graph.
- `template` must be a string literal, or `templateUrl` a relative path. A client component, or a
  local component composed under a Server Component, must have a single custom element selector
  and be declared in an app module imported by a relative specifier (`./x` → `./x.ts`).
  Components from packages cannot be client boundaries yet.
- **Buffered SSR only.** Analog's experimental streaming is unsupported and not qualified (see
  [Failure and recovery](#failure-and-recovery)).
- Recursive composition is not supported: a cycle fails the build.
- `@defer` in a server-owned template fails the build (see
  [Angular `@defer`](#angular-defer-and-incremental-hydration)); a client component's own
  `@defer` is Angular's.
- Dynamic rendering (`NgComponentOutlet`, `ViewContainerRef.createComponent`) is invisible to the
  analysis; such a component is server-owned and any boundary it renders has no client reference.
- An ordinary component is server-owned only where a Server Component renders it. Imported
  directly by a client page, it is an ordinary browser component, with everything it imports.
- **Module-level server state is not shared with Nitro code.** Analog builds the Angular SSR
  bundle separately from Nitro's server bundle, so a module imported by both a Server Component
  and a controller (or any Nitro plugin/route) is evaluated twice, each copy with its own state.
  Keep such state in one process-wide instance (`globalThis` keyed by `Symbol.for(...)`, as
  Relay's `processSingleton` does) or in external storage.
- Relies on undocumented Angular hydration behaviour (hydrating a root onto an `ngh`-annotated
  host) and on Analog's Vite environment names (`client`).
- Dev server (`vite`): see [Dev server](#dev-server-vite) for the measured contract. The plugin
  adds the runtime package to `optimizeDeps.include`, because Analog links partial-compiled
  Angular libraries in dev only while pre-bundling them, and to `ssr.noExternal`, so an installed
  (not linked) copy is linked by Analog for Node SSR instead of falling back to the JIT compiler.
