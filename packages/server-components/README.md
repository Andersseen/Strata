# @strata-sc/server-components

**PRIVATE / EXPERIMENTAL.** `private: true`, not published, no changesets, no stable API.

The server-component graph mechanism qualified in `docs/research/server-component-*.md`, extracted
from the Analog fixture so an Analog app consumes it as a workspace package. Behaviour is identical
to the PoC.

## Qualification

- Angular 22.1.7, Analog 2.7.2, Vite 8.
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
- **Document navigation only.** An Angular Router navigation to a route containing a server
  component renders the empty surrogate, silently. There is no server payload or router
  integration.

## Entries

| Import                              | Contents                                                                                                        | Graph             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------- |
| `@strata-sc/server-components`      | `ServerComponent`, `StrataClientBoundary`, `ClientBoundaryProps`, `StrataIslandHost`, `provideClientReferences` | server + browser  |
| `@strata-sc/server-components/vite` | `strataServerComponents(options)`                                                                               | build (Node) only |

The runtime entry imports only `@angular/core`. It is Angular partial-compiled by `ngc` into
`dist/fesm2022/`; Analog 2.7.2's build optimizer runs the Angular linker only on paths matching
`/fesm20/`. The `/vite` entry imports `typescript`, `@angular/compiler` (template parsing), `vite`
types and Node built-ins; nothing in the runtime entry imports it.

## Use

```ts
// vite.config.ts
strataServerComponents({
  root: import.meta.dirname,
  sourceDir: "src/app",
  generatedDir: "src/generated/server-components", // in the Angular program, gitignored
  enabled: true, // false: plain-SSR control build
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
  path, `load` fails the build.
- `StrataClientBoundary` props are plain data only: `string`, `number`, `boolean`, `null` values
  in a flat object.
- `StrataIslandHost` hydrates each boundary as its own root from its `ngh` annotation and destroys
  those `ComponentRef`s when the host is destroyed.

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
- Recursive composition is not supported: a cycle fails the build.
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
- Dev server (`vite`): smoke-checked by hand only (hydration, one click, no console errors). The
  plugin adds the runtime package to `optimizeDeps.include`, because Analog links partial-compiled
  Angular libraries in dev only while pre-bundling them.
