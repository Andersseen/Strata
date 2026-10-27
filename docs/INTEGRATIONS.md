---
type: guide
---

# Controllers and server integrations

How Strata's controller packages and Server Components attach to the runtimes you already own.
Everything here is experimental. Behaviour claims are limited to what the linked evidence shows;
unsupported items are called out explicitly. The package READMEs hold the full API reference.

Server Component applications may opt into `provideStrataHydrationObserver()` for a privacy-safe
terminal event per host transaction. The application owns any telemetry transport. It complements
the existing Angular `ErrorHandler` and `provideSkewRecovery()` and does not observe later Angular
runtime errors or deferred child hydration; see the [0.10 candidate evidence](research/server-component-hydration-observability-v010.md).

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
  including on failure paths. It covers the controller invocation, not a response body, unless the
  handler returns the opt-in `streamResponse()`, which keeps the scope open until its body completes,
  fails or is cancelled. Client disconnect is not propagated to the body, so a streamed body must be
  finite; Cloudflare Pages buffers it ([evidence](research/analog-stream-lifecycle-v07.md)).
- Angular DI is possible only through injectors your application owns
  ([SPEC-003](specs/003-analog-request-lifecycle-angular-di.md), a **conditional go**, not a
  Strata API). Resolve dependencies at construction; `inject()` inside a handler throws `NG0203`.
  The Cloudflare run of that DI experiment was a no-go
  ([report](research/server-component-cloudflare-poc.md)).

Registration preflight compares normalized final route shapes made of static and whole named
parameter segments. Same-method routes that differ only by parameter names fail before Nitro's
router is touched. Nitro/H3 v1 shares parameter metadata across methods, so two methods may use the
same exact template, but different templates with the same shape are rejected. Static routes remain
distinct from parameter routes. Unsupported Nitro pattern forms outside an API boundary keep Nitro's
existing behavior; only exact method/path duplicates are checked for those patterns. Strata cannot
see native Nitro registrations or Analog-generated routes, so undeclared native collisions are not
validated. See the [registration integrity evidence](research/analog-registration-integrity-v011.md).

For the source-level examples, including the factory and cleanup, see the
[repository README](../README.md#analog).

#### HTTP application contract

`@strata-sc/analog` exports `StrataAnalogHttpError` for expected application
failures and `jsonResponse` / `noContent` for explicit native Web responses.
Recognized error statuses are 400, 404, 409, 422, 429 and 503; each produces
only `{ error: code }`, JSON UTF-8 content type and `Cache-Control: no-store`.
Messages, causes, stacks, schema issues and custom detail objects are not sent
to clients. Existing validation errors and guard 401/403 responses keep their
own contracts. Errors translate only after cleanup succeeds; cleanup failures
remain server failures. See the complete, packed-consumer-typechecked example
in [`@strata-sc/analog`](../packages/analog/README.md#complete-consumer-example)
and the [0.5.0 qualification](research/analog-http-contract-v05.md).

`jsonResponse(value, init?)` defaults to 200, preserves supplied headers,
including multiple cookies, and uses the native `Response` constructor for
status/body validation. `noContent(init?)` returns a bodyless 204 without a
content type. Plain controller values and native `Response` results remain
valid. These helpers only affect Strata controller results, not native Nitro
routes.

`StrataAnalogRequest` does not expose `signal` in this release. The pinned
Nitro/H3 Node and Cloudflare Pages adapters do not carry a trustworthy transport
signal into the controller boundary; see the cancellation verdict in the
[qualification report](research/analog-http-contract-v05.md#cancellation-investigation).

#### HTTP routing and API boundary

Without extra configuration, a request that matches no registered route falls through to Analog's HTML
renderer, so `GET /api/unknown` answers `200 text/html` and an unsupported method on a known path does
too. The opt-in `apiBoundary` option of `registerControllers()` makes explicitly listed prefixes an API
namespace: unknown paths answer a safe JSON `404`, known paths with an unsupported method answer `405`
with an `Allow` derived from route metadata, `HEAD` is derived from the matching `GET` route (one
pipeline run, no body), and plain `OPTIONS` can be answered without ever answering a CORS preflight or
adding CORS headers. The boundary is a low-priority fallback registered on `/<prefix>` and
`/<prefix>/**` of Nitro's router, so native Nitro routes, Analog pages, static assets and Analog server
functions (`/_analog/fn/:id`) are never shadowed. Framework `404`/`405`/`OPTIONS` answers run no guard,
interceptor or controller factory; keep request-wide policy in Nitro middleware. Native routes under the
prefix are declared with `nativeRoutes` for accurate `405`s. Under `vite dev`, Vite's own CORS middleware
answers `OPTIONS` before Nitro; the boundary leaves it untouched. See the
[package README](../packages/analog/README.md#api-boundary-404-405-head-and-options) and the
[qualification report](research/analog-http-routing-v06.md).

#### Request observation (opt-in)

`registerControllers()` accepts `onRequestSettled(observation)`, called once per Strata-owned invocation after
its cleanups settled (for an owned `streamResponse()`, when the body completes, fails or is cancelled). The
observation holds the registered route template, a finite outcome, the phase, `streaming`, `cleanup`, a status
only where Strata produced it and two monotonic durations; never request values, headers, bodies or error
details. The callback is synchronous and cannot change the response; asynchronous export is the application's
responsibility. Native routes, server functions and the API boundary's own 404/405 are not observed. See the
[package README](../packages/analog/README.md#observing-requests-onrequestsettled) and the
[qualification report](research/analog-request-observability-v08.md).

**Header validation (0.9 candidate).** `request.validateHeaders(schema)` validates a frozen lowercase string snapshot with any
Standard Schema v1 library (Zod, Valibot, handwritten) and infers the output. Failures answer the safe `source: "headers"` 400.
It checks shape only: Strata verifies no credential and trusts no forwarding header. See the
[package README](../packages/analog/README.md) and the [report](research/analog-header-validation-v09.md).

**URL-encoded form validation (0.10 candidate).** `request.readValidatedForm(schema)` validates only an explicitly
read `application/x-www-form-urlencoded` body with Standard Schema v1. Repeated values are ordered arrays, field names
stay literal, plus and percent decoding follow form URL encoding, and malformed escapes/UTF-8 fail with safe 400.
The reader enforces a 1 MiB byte limit and a 10,000 non-empty field limit; unsupported content types or charsets fail
with safe 415. The raw readers remain unchecked, and a raw-first call prevents later validated reads from bypassing
the limit. This adds no upload handling or automatic route validation. State-changing forms still need a
consumer-owned CSRF/origin policy. Node production, Analog dev, local workerd and the external packed consumer pass;
hosted CI remains pending ([report](research/analog-validated-forms-v010.md)).

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

- Only an element marked `[strataClient]` hydrates. Its props are explicit public data: primitives,
  dense arrays and plain objects, recursively validated on the server and browser. Flat primitive
  payloads use protocol v1; structured payloads use protocol v2. Limits are 8 nested levels, 512
  values, 128 array items, 64 object keys, 64 root props and 64 KiB UTF-8. Both previews are
  experimental and not stable. See the
  [client boundary protocol](../packages/server-components/README.md#client-boundary-protocol).
- A module importing `@strata-sc/server-components/server-only` must never enter the browser
  graph; violating that fails the production build, including through Vite aliases, tsconfig paths,
  index files, re-export chains, query imports and package modules that assert it. A package listed
  in `clientComponents` is not exempt
  ([details](../packages/server-components/README.md#server-only-modules),
  [report](research/server-component-graph-security-v06.md)). In `vite` dev the same assertion is enforced
  inside Vite's dependency optimizer (0.9, [report](research/server-component-optimized-dependency-firewall-v09.md))
- A standalone Angular component from an installed library may be an island only when its selector,
  bare package entry point and named export are explicitly declared in `clientComponents` and that
  same export is imported into the Server Component. The feature is experimental and scoped to the
  tested package tuple and export shape; see
  [package islands](../packages/server-components/README.md#external-angular-package-islands).
- Interactive bindings in server-owned templates, and `@defer` in a server-owned template, fail
  the build. `@defer` inside an island is Angular's own
  ([report](research/server-component-defer-poc.md)).

### What is not supported

Do not rely on any of these (see the package
[limitations table](../packages/server-components/README.md#limitations-read-these-first)):

- Angular Router navigation into a new Server Component subtree is a recorded **no-go**; it
  silently renders the empty surrogate. Only document navigation is qualified
  ([report](research/server-component-navigation-poc.md)). Link with `StrataDocumentLink`, navigate
  programmatically with `StrataDocumentNavigator` and protect routes with
  `strataDocumentNavigationGuard`, all from `@strata-sc/server-components/navigation`
  ([document-navigation report](research/server-component-document-navigation-v04.md)); plain
  `<a href>` stays valid.
- Streaming SSR; unregistered or arbitrary package components as islands; content projection into
  islands (not qualified); a request-scoped Server Component context.
- Server render errors answer HTTP 200 (current Angular/Analog behaviour), see
  [failure and recovery](research/server-component-failure-recovery.md).

### Evidence and qualification

Qualified on Node 22 with Nitro `node-server`, and on Cloudflare workerd **locally** through
Wrangler. A real deployed Cloudflare qualification is tracked separately
([deployed report](research/server-component-deployed-cloudflare.md)); treat local workerd,
deployed workerd, conditional support and release readiness as four different claims, per
[ADR-003](adr/003-server-components-release-gate.md) and the [1.0 gates](RELEASE-1.0.md).
Data confidentiality evidence: [report](research/server-component-data-security.md).

- Deploying across releases: set `buildId` (one value per release, shared by every part of the build) so a
  document and a script from different builds are refused with a classified error instead of hydrating the
  wrong code; `provideSkewRecovery({ reload: true })` additionally allows one bounded document reload. Scripts
  built before the option cannot detect it. See the [package README](../packages/server-components/README.md#deployment-compatibility).

## Where to read next

- [Current state](STATE.md) for implemented facts and [Roadmap](ROADMAP.md) for intent only.
- [Risks](RISKS.md) for what is still uncertain.
- [Testing strategy](TESTING.md) for the commands that produce the evidence.
