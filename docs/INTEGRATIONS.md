---
type: guide
---

# Controllers and server integrations

How Strata's controller packages and Server Components attach to the runtimes you already own.
Everything here is experimental. Behaviour claims are limited to what the linked evidence shows;
unsupported items are called out explicitly. The package READMEs hold the full API reference.

## Controllers

`@strata-sc/core` exports `Controller`, the route decorators `Get`, `Post`, `Put`, `Patch` and
`Delete`, `getControllerDefinition`, and types. Decorators are **standard ECMAScript decorators**
with explicit metadata, not legacy parameter decorators
([ADR-001](adr/001-standard-decorators.md)). They only record metadata; a runtime adapter
reads it with `getControllerDefinition`.

```ts
import { Controller, Get } from "@strata-sc/core";

@Controller("/users")
class UsersController {
  @Get()
  findAll() {
    return [{ id: "1" }];
  }
}
```

An adapter registers controllers on a router you create and keep control of. Strata does not own
the HTTP runtime. The two adapters target **different H3 majors**:

| Adapter                                | Runtime it registers on                            | H3 major |
| -------------------------------------- | -------------------------------------------------- | -------- |
| `@strata-sc/h3` (private, unpublished) | An `H3` app you create                             | **v2**   |
| `@strata-sc/analog` (published, `0.x`) | `nitroApp.router`, owned by Nitro 2 under Analog 2 | **v1**   |

Do not mix them up: Analog 2 runs on Nitro 2, which runs on H3 v1, so the H3 v2 adapter does not
apply to Analog. `@strata-sc/analog` depends only on `@strata-sc/core` and exposes no H3
declarations ([ADR-002](adr/002-core-and-h3-target.md), [Compatibility](COMPATIBILITY.md)).

### H3 v2 constraints

The `@strata-sc/h3` runtime path passes in a packed consumer, but strict TypeScript 6.0.3 consumers
fail in H3 / crossws declarations. This is upstream-blocked and keeps milestone M1 blocked
([SPEC-002](specs/002-h3-consumer-type-closure.md),
[evidence](research/h3-consumer-type-compatibility.md)). It creates one controller instance per
controller at registration, shared across requests: never keep request state on it.

### Analog and Nitro

Register from a Nitro server plugin:

```ts
// src/server/plugins/strata.ts
import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { UsersController } from "../strata/users.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController]);
});
```

Verified behaviour (Analog 2.7.2, Nitro 2.13.4; see the
[integration baseline](research/analog-integration-baseline.md)):

- Controllers are **request-scoped**: a new instance per request, `new Controller()` by default,
  or one created by the experimental `controllerFactory` option.
- A handler may take one provisional `StrataAnalogRequest` with params, query, headers, URL and lazy
  body readers. Nitro's H3 event is not exposed.
- `onCleanup` on the factory context runs registered callbacks last-in-first-out, exactly once,
  including on failure paths. It covers the controller invocation, not a streamed response body.
- Angular DI is possible only through injectors your application owns
  ([SPEC-003](specs/003-analog-request-lifecycle-angular-di.md), a **conditional go**, not a
  Strata API). Resolve dependencies at construction; `inject()` inside a handler throws `NG0203`.
  The Cloudflare run of that DI experiment was a no-go
  ([report](research/server-component-cloudflare-poc.md)).

For the source-level examples, including the factory and cleanup, see the
[repository README](../README.md#analog).

#### Consumer-owned Angular DI (experimental, Node only)

Strata does not create an Angular injector or automatically connect to Analog's SSR or
server-function injectors. If an application needs Angular services in a Strata controller, it can
own a separate application injector and create a child injector in `controllerFactory`:

```ts
import "@angular/compiler";
import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import { createApplication } from "@angular/platform-browser";
import { platformServer, provideServerRendering } from "@angular/platform-server";
import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

export default defineNitroPlugin(async (nitroApp) => {
  const platform = platformServer();
  const app = await createApplication(
    { providers: [provideServerRendering()] },
    { platformRef: platform },
  );
  nitroApp.hooks.hook("close", () => {
    app.destroy();
    platform.destroy();
  });

  registerControllers(nitroApp.router, [InventoryController], {
    controllerFactory: (Controller, { request, onCleanup }) => {
      const child = createEnvironmentInjector(
        [{ provide: STRATA_REQUEST, useValue: request }, RequestIdentity],
        app.injector,
      );
      onCleanup(() => child.destroy());
      return runInInjectionContext(child, () => new Controller());
    },
  });
});
```

The fixture evidence is limited to Nitro `node-server` with Angular JIT and a consumer-owned
injector. In the consumer's Vite config, retain the compiler in Nitro with
`analog({ nitro: { moduleSideEffects: ["@angular/compiler"] } })`. Keep this configuration out of Worker builds: **Angular DI on workerd is not supported on
the tested JIT path**, which fails because workerd disallows code generation from strings. The
internal and external injector is separate from Analog SSR and server-function injectors. See the
[packed consumer evidence](research/analog-packed-di-consumer.md) and the existing
[workerd limitation](research/analog-di-cross-runtime-lifecycle.md).

## Server Components

`@strata-sc/server-components` (experimental, `0.x`) renders a `@ServerComponent()` on the server
and keeps its implementation out of the browser graph. Interactivity comes only from explicit
`[strataClient]` islands that Angular hydrates over the server-rendered DOM. Setup is a Vite plugin
(`strataServerComponents` from `@strata-sc/server-components/vite`) placed **before** `analog()`;
the exact configuration is in the
[package quick start](../packages/server-components/README.md#quick-start).

### Client boundaries and hydration

- Only an element marked `[strataClient]` hydrates. Its props are a flat plain object of
  `string`, finite `number`, `boolean` or `null`, validated on the server (64 props, 64 KiB maximum)
  under protocol v1, which is not stable. See the
  [client boundary protocol](../packages/server-components/README.md#client-boundary-protocol).
- A module importing `@strata-sc/server-components/server-only` must never enter the browser
  graph; violating that fails the production build
  ([details](../packages/server-components/README.md#server-only-modules)).
- Interactive bindings in server-owned templates, and `@defer` in a server-owned template, fail
  the build. `@defer` inside an island is Angular's own
  ([report](research/server-component-defer-poc.md)).

### What is not supported

Do not rely on any of these (see the package
[limitations table](../packages/server-components/README.md#limitations-read-these-first)):

- Angular Router navigation into a new Server Component subtree is a recorded **no-go**; it
  silently renders the empty surrogate. Only document navigation is qualified
  ([report](research/server-component-navigation-poc.md)).
- Streaming SSR; components from packages as islands; content projection into islands (not
  qualified); a request-scoped Server Component context.
- Server render errors answer HTTP 200 (current Angular/Analog behaviour), see
  [failure and recovery](research/server-component-failure-recovery.md).

### Evidence and qualification

Qualified on Node 22 with Nitro `node-server`, and on Cloudflare workerd **locally** through
Wrangler. A real deployed Cloudflare qualification is tracked separately
([deployed report](research/server-component-deployed-cloudflare.md)); treat local workerd,
deployed workerd, conditional support and release readiness as four different claims, per
[ADR-003](adr/003-server-components-release-gate.md) and the [1.0 gates](RELEASE-1.0.md).
Data confidentiality evidence: [report](research/server-component-data-security.md).

## Where to read next

- [Current state](STATE.md) for implemented facts and [Roadmap](ROADMAP.md) for intent only.
- [Risks](RISKS.md) for what is still uncertain.
- [Testing strategy](TESTING.md) for the commands that produce the evidence.
