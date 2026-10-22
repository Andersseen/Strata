---
type: guide
---

# Getting started

Strata is **experimental, pre-1.0 software**. Read [Current state](STATE.md) for what was actually
verified and [Compatibility](COMPATIBILITY.md) for what may be claimed before depending on it. This
page only orients you; it never overrides those two documents.

## What is published

| Package                                                                   | Registry status                                    | Role                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| [`@strata-sc/core`](../packages/core/README.md)                           | npm, `0.x`                                         | `@Controller` and HTTP method decorators (metadata only) |
| [`@strata-sc/analog`](../packages/analog/README.md)                       | npm, `0.x`                                         | Registers controllers on Analog/Nitro's router           |
| [`@strata-sc/server-components`](../packages/server-components/README.md) | npm, `0.x`; experimental, document navigation only | Server Components with explicit `[strataClient]` islands |
| [`@strata-sc/h3`](../packages/h3/package.json)                            | **private, not published**                         | Registers controllers on an H3 v2 app                    |

Stable releases are on the `latest` dist-tag; release candidates, when there are any, on `next`
([ADR-005](adr/005-npm-dist-tag-channels.md)). `0.x` releases may break in any minor. Check the
[release gates](RELEASE-1.0.md): nothing here is a 1.0 promise.

## Prerequisites

- Node.js 22 for consuming the packages. Developing this repository needs Node.js `>=22.22.3` and
  pnpm `10.30.1` (see the root `package.json` `engines` and `packageManager`).
- The versions Server Components were qualified against are listed in the package README under
  [Compatibility](../packages/server-components/README.md#compatibility): Angular 22.1.7, Analog
  2.7.2, Vite 8.3.0, Node 22. Other versions were never qualified.

## Install in an application

```bash
pnpm add @strata-sc/core @strata-sc/analog
pnpm add @strata-sc/server-components   # only for Server Components
```

External projects should install from the registry rather than link to a checkout.

For safe application error responses and explicit JSON/204 responses in
Analog controllers, see the [HTTP application contract example](../packages/analog/README.md#complete-consumer-example).
The API is experimental and its `0.x` behavior may change in a minor release.

## Pick a path

1. **HTTP controllers in an Analog app** — follow [Controllers and server integrations](INTEGRATIONS.md).
2. **Server Components** — follow [Server Components](INTEGRATIONS.md#server-components) and then the
   package README, which is the full reference. Keep repositories and secret loaders behind
   `import "@strata-sc/server-components/server-only"` and share only DTO types with islands: the
   build rejects an island that reaches one through a relative path, a Vite alias, a tsconfig path,
   a barrel or a package ([recipe](../packages/server-components/README.md#server-only-recipe)).
3. **Understand the design before using it** — [Architecture](ARCHITECTURE.md), [Vision](VISION.md)
   and the accepted [ADRs](README.md#accepted-decisions).

## Run the repository locally

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Examples that exercise the packages in a real Analog application:

| Application                                                  | Purpose                                                                                              | Run                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------ |
| [`apps/www`](../apps/www/package.json)                       | Official website; its homepage dogfoods one Server Component. Deployed to Cloudflare Pages.          | `pnpm www:dev`     |
| [`apps/relay`](../apps/relay/package.json)                   | Private, local-only operations console using controllers and Server Components. Not deployed.        | `pnpm relay:dev`   |
| [`apps/analog-fixture`](../apps/analog-fixture/package.json) | Test fixture behind `pnpm test:analog`, `pnpm test:server-components` and the navigation experiments | `pnpm test:analog` |

For Server Component islands, `[strataClient]` accepts readonly public view models containing
strings, finite numbers, booleans, null, dense arrays and plain objects within documented limits.
Every value passed through that input becomes browser-visible. Flat props remain protocol v1;
nested props use protocol v2. See the
[structured boundary example](../packages/server-components/README.md#client-boundary-protocol).
Installed Angular package components can also be used as islands when each selector, package entry
point and named export is explicitly registered in `strataServerComponents`; see
[external Angular package islands](../packages/server-components/README.md#external-angular-package-islands).

Qualification commands (`pnpm test:consumer`, `pnpm test:server-components`,
`pnpm test:server-components:cloudflare`, ...) are described in [Testing strategy](TESTING.md).
`pnpm test:consumer` is expected to fail on a strict-types criterion while the H3 type blocker
stands; see [Current state](STATE.md).

## Maintaining these docs

Documentation is Markdown in this directory, compiled by Entwine. See
[Documentation workflow](DOCUMENTATION.md).
