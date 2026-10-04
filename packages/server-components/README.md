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
- Angular `@defer` / incremental hydration inside client islands, on Node and workerd:
  `pnpm test:server-component-defer`, `pnpm test:server-components:cloudflare`, and Relay's rollout
  island (see [Angular `@defer`](#angular-defer-and-incremental-hydration)).
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
- `StrataClientBoundary` props are plain data only, validated at runtime: see
  [Client boundary protocol](#client-boundary-protocol).
- `StrataIslandHost` hydrates each boundary as its own root from its `ngh` annotation and destroys
  those `ComponentRef`s when the host is destroyed.

## Client boundary protocol

Preview protocol, version 1. **Not stable.** It hardens the existing value set; it does not widen
it. The authoring API is unchanged: `[strataClient]="{ someInput: value }"`.

**Props are public browser data.** Everything placed in `[strataClient]` is written into the HTML
and readable by anyone who loads the page. Serialization is not a security boundary, and Strata
cannot tell whether a string is a secret: `[strataClient]="{ token: internalSecret }"` leaks it, by
the developer's explicit choice. There is no name-based heuristic.

What Strata does guarantee is that nothing crosses _implicitly_. The server validates the props at
runtime, so a cast (`as unknown as ClientBoundaryProps`) or a dynamic value cannot carry a service,
repository, class instance, function, closure, signal or nested object across. Reduce server values
to explicit primitive props first.

### Server: validate, then serialize

| Rule        | Contract                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape       | One plain, non-array object (prototype `Object.prototype` or `null`) of own, enumerable, string-keyed data properties. Getters never run; accessors, symbol keys and non-enumerable props fail. |
| Values      | `string`, `boolean`, `null`, and `number` only where `Number.isFinite`. `NaN` and `±Infinity` fail, because JSON would turn them into `null`.                                                   |
| Rejected    | `undefined`, `BigInt`, functions (signals included), symbols, arrays, nested objects, `Date`, `Map`, `Set`, `RegExp`, `Promise`, `Observable`, any class instance.                              |
| Keys        | `__proto__`, `prototype` and `constructor` fail.                                                                                                                                                |
| Limits      | At most 64 props, and at most 64 KiB (65 536 bytes) of serialized JSON measured as UTF-8 with `TextEncoder`, not as UTF-16 length.                                                              |
| Determinism | JSON of the validated entries in the object's own-property order. Keys are not sorted.                                                                                                          |
| Fidelity    | Values round-trip exactly, except `-0`, which JSON writes as `0`.                                                                                                                               |

A violation throws a `StrataBoundaryError` before `JSON.stringify` runs. Nothing is dropped,
coerced or stringified. The message names the boundary selector, the prop, what was received and
the allowed value set:

```
[strata] Cannot serialize client boundary <relay-widget>: prop "createdAt": Date is not supported.
Allowed values: string | finite number | boolean | null, in one flat plain object of at most 64
props and 65536 UTF-8 bytes serialized. …
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
  ngh="0"
></quantity-picker>
```

Each attribute has one job: `data-strata-client` holds the host's own selector,
`data-strata-protocol` the protocol version, and `data-strata-props` the props (always written, `{}`
included). The version is not wrapped in an envelope inside the props.

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
   `"1"`. A missing protocol is incompatible (it is not read as version 1), and an unknown protocol
   is refused without parsing its props. `data-strata-props` must be present, within the size limit,
   valid JSON, and pass the same value contract as on the server. `data-strata-client` must equal
   the host's `localName` and the client reference's selector. Every prop must be a public input
   name of that component, read from `reflectComponentType(type).inputs` (`templateName`, so input
   aliases are honoured; the property name of an aliased input is refused with a hint).
3. **Commit**: `createComponent` on each host, `setInput` per validated entry (the parsed object is
   never merged into anything), `attachView`. Then each host gets `data-strata-hydrated`.

A preflight failure throws one `StrataBoundaryError` naming the boundary, its position and the
reason, before any `ComponentRef` exists. That covers version skew, invalid JSON, a missing
protocol or props attribute, a reserved key, an unsupported value, an unknown input and a selector
mismatch. The server-rendered DOM stays in place, inert. There is no client-side re-render, CSR
fallback or reload. A reload strategy is not defined yet.

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
   the protocol v1 preflight. That is unchanged: the root is not hydrated lazily.
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
- Dev server (`vite`): smoke-checked by hand only (hydration, one click, no console errors). The
  plugin adds the runtime package to `optimizeDeps.include`, because Analog links partial-compiled
  Angular libraries in dev only while pre-bundling them.
