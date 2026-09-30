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
- Dogfooded by Relay (`apps/relay`): three Server Components, islands side by side and inside
  `@for`, and a Server Component reading the Strata controllers' own store:
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

## Experimental restrictions

- One named `@ServerComponent()` class per module, stacked on `@Component({...})`.
- `selector` must be a string literal; `imports` entries must be plain identifiers bound by named
  imports.
- **Client references are explicit.** The plugin parses the server component's template with
  `@angular/compiler`'s `parseTemplate`. Only an `imports` entry whose component selector is an
  element marked `[strataClient]` becomes a client reference. Every other import (a server-only
  child component, a pipe, a directive, anything from a package) stays in the server graph. A
  marked element that no import matches fails the build.
- `template` must be a string literal, or `templateUrl` a relative path. A client component must
  have a string literal element selector and be declared in an app module imported by a relative
  specifier (`./x` → `./x.ts`). Components from packages cannot be client boundaries yet.
- Not qualified yet: an unmarked child _component_ (server-rendered only, never hydrated by the
  surrogate). The fixture's server-only import is a pipe.
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
