# External Angular package islands

Status: locally qualified implementation candidate on the feature branch; hosted CI and release
verification are pending. Starting `main` SHA: `88f68832361694caf683d529adc15d5e628559ea`.

## Public configuration

`strataServerComponents` accepts `clientComponents`, an array of explicit registrations:

```ts
clientComponents: [
  {
    selector: "acme-product-picker",
    module: "@acme/angular-widgets",
    exportName: "ProductPickerComponent",
  },
];
```

`module` is a bare package specifier, including an optional package subpath. `exportName` is a named
export. Selectors must be custom element names. Missing fields, getters, extra keys, invalid values
and duplicate selectors fail synchronously when the plugin is configured, before graph generation.
Aliases such as `ProductPickerComponent as Picker` work because the analyzer matches the imported
export name, not the local binding name. Default and namespace imports are not supported.

`@acme/angular-widgets` and `ProductPickerComponent` above are placeholders. Consumers must replace
them with an installed package and its actual public export. The runnable test fixture uses the
private tarball `@strata-test/angular-widgets` and is never published.

## Resolution and Angular compilation

The analyzer walks only app-owned component metadata. A package reference becomes a client reference
only when all three inputs match: the element has `[strataClient]`, the server-owned component lists
the imported package symbol in its Angular `imports`, and that import's package plus exported name
matches one registry entry for the element selector. The component class is not parsed or crawled.
Unmarked package components stay opaque. Local app components keep their existing relative-import
resolution and are checked first for selector conflicts.

The browser surrogate imports the exact named export from the bare package specifier. Vite includes
registered package entry points in dev dependency prebundling and bundles them in the SSR graph so
Angular's linker can process partial declarations. Angular AOT then sees the same library component
in the server-owned template and the generated surrogate's provider. No JIT compiler, private Ivy
API or Strata runtime import is added to the package.

The test-only library is independently compiled with Angular's public `ngc` compiler using
`compilationMode: "partial"`, then packed as a private tarball using an Angular Package Format
`dist/fesm2022` entry point. This path lets Analog's Angular linker process partial declarations in
the SSR bundle. An initial non-APF fixture exposed the JIT fallback; moving the entry into the normal
FESM path made the linked production consumer pass. The isolated npm consumer uses a peer-compatible
Angular 22.2.3 set, `@angular/build` 22.1.8, Analog Router 2.8.1 and Vite 8.3.0.

## Boundary data and security

Package components use the existing protocol. Primitive-only root props remain v1. Nested view models
use v2, with unchanged limits: 64 root props, 8 nested containers, 512 values, 128 array elements,
64 keys per object and 64 KiB serialized JSON per boundary. Runtime input reflection uses Angular's
public component mirror and checks the public (aliased) input name before assignment. Each boundary
keeps its own validated data snapshot.

The package is not an automatic trust grant. The usual browser graph firewall remains active for
server-owned components and explicitly marked server-only modules. A package that imports Strata's
server-only assertion is rejected if that dependency enters the browser graph. Browser-bundled
packages must otherwise be independently safe for browser use; this feature does not scan every
file in `node_modules`. Never include repositories, secrets or private values in the boundary DTO.

## Development behavior

Consumer app edits regenerate the same transactional graph as before. A registry change requires a
Vite restart because the plugin options are read at startup. Installed package source is not watched;
rebuild/reinstall the package and restart the dev server after changing it. Failed graph analysis
continues to close the client graph until the app source is valid again. Existing server-owned edit
reload behavior is unchanged.

## Qualification status

| Check                                                                               | Result on this branch                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Analyzer, registry validation, local references and package surrogate unit tests    | 257 Server Components tests pass                                         |
| Package declarations, package build and repository build/typecheck/lint/format/test | Pass                                                                     |
| Independent fixture partial compilation and pack                                    | Pass; Angular partial declarations in FESM entry                         |
| Isolated npm install and TypeScript 5.9/6 declaration portability                   | Pass                                                                     |
| Consumer Angular AOT, Node SSR, v1/v2 and Chromium hydration/interaction            | Pass; DOM identity, aliased structured input and sibling-state isolation |
| Installed-plugin server-only firewall and graph confidentiality                     | Pass                                                                     |
| Vite dev, package-island hydration and server-owned edit reload                     | Pass                                                                     |
| Cloudflare Pages build and local workerd SSR/hydration                              | Pass                                                                     |
| Browser/SSR bundle size comparison                                                  | Not measured                                                             |
| Hosted CI and published registry verification                                       | Pending; branch has not been pushed and nothing is published             |

The qualification runner passed with zero failures. It verifies the independent tarballs are
installed outside the workspace, one Angular runtime is present, browser maps and bundles exclude
server implementation files, and the package component hydrates the server-rendered DOM. The
feature remains a candidate until hosted CI completes; no production app adoption or release is
claimed.

## Limits and migration

Registration is opt-in and exact. Re-export barrels, namespace imports, default imports, package
source crawling, global component registries and automatic island discovery remain unsupported.
Angular AOT is expected to reject an export that is not a standalone component or whose actual
selector does not match the element. Those negative package-export cases are not part of the passing
positive consumer fixture. The qualified peer ranges remain unchanged.

Existing local-component configurations need no migration. To try a package component, install a
publicly exported standalone library, add one registry entry, import that same named export into the
Server Component's `imports`, and send a public DTO through `[strataClient]`. Restart Vite after
changing the registration or installed package.
