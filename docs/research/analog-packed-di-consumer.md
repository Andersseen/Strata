# Packed Angular DI consumer on Nitro Node

**Result: partial GO for a minimal external Node consumer.** This qualification extends the existing
internal Angular DI composition with a consumer-side application injector, an Angular controller,
verified synthetic credentials, a request child injector and a real production HTTP server. It does
not qualify the complete validation, interceptor, cleanup-failure, bundle or release matrix
requested for Strata 1.0.

## Basis and installed tuple

- Starting main SHA: `8272ce98e3908c40d788ce00363c675917c85a34`.
- Feature branch: `test/analog-packed-angular-di-consumer`.
- Strata packages built and packed from this checkout: `@strata-sc/core@0.2.2`,
  `@strata-sc/analog@0.4.0`, `@strata-sc/server-components@0.2.1`.
- SHA-256: core `49434df58bb205fb1a69c07eb1b9b6cb334b2e1b7161343f1cbbc0167995bfcb`;
  analog `3924c74e73526a47b2debcdf784f482f780839896d42434fc7e59ecef359d1a7`;
  server-components `d648e51d3ff367497d1cf9103817df81514337ba7c166c2b444f2f0a860fe635`.
- Consumer tuple: `@angular/*@22.2.3`, `@angular/build@22.1.8`, Analog 2.7.2,
  `nitropack@2.13.4`, `h3@1.15.11`, Vite 8.3.0, TypeScript 6.0.3, Node 22.23.1.
- The shared package-consumer installer runs `pnpm pack`, copies the app to an OS temporary
  directory, installs the tarballs with npm, and verifies installed bytes against tarball contents,
  package-lock integrity, package versions, public entry resolution, and a single installed core.
  The consumer has no workspace path mappings or links into this repository. `npm ls --all` exits
  nonzero with peer/optional dependency diagnostics in the broader Analog tree; the installer
  rejects relevant Strata/framework package defects, and the npm install itself succeeds.

## What was exercised

The fixture owns its Angular `createApplication()` root on the Nitro app, destroys its application
and platform once on Nitro's `close` hook, and creates one `createEnvironmentInjector()` per
authorized Strata controller invocation. The controller is constructed synchronously with
`runInInjectionContext()` and captures injected `CatalogService`, `RequestIdentity` and
`StrataAnalogRequest` values before awaiting. It does not call `inject()` from an async handler.

The consumer composes public `registerControllers`, `controllerFactory`, `onCleanup`,
`StrataAnalogGuard`, `StrataAnalogInterceptor` and `StrataAnalogRequest` APIs with Angular's
`createApplication`, `createEnvironmentInjector`, `runInInjectionContext`, `EnvironmentInjector`,
`InjectionToken` and `DestroyRef`. Its dependencies are owned by the consumer. It uses no Strata DI
container, Angular dependency in `@strata-sc/analog`, private H3 adapter or worker runtime code.

Strict TypeScript 6.0.3 and 5.9.2 compilation pass for the consumer's Angular services, controller,
guard, interceptor and factory types with `strict: true` and `skipLibCheck: false`. Both compilers
read the installed Angular and Strata declarations; the consumer source stays outside the workspace.

The production Node HTTP run passes: missing and invalid credentials return 401; a cross-principal
resource returns 403; denial is `no-store`; a native Nitro API route coexists with the Strata route;
and 24 simultaneous authorized requests retain the right alpha/beta identity. Each request has a
unique request service, while the application catalog service is reused. Captured services remain
available after `await`. The final stats endpoint observes 24 created and destroyed request
injectors, 24 identity destruction callbacks, 24 controller destruction callbacks and zero live
request injectors. Guard cleanup runs 27 times across the 24 authorized and three denied requests,
while interceptors and handlers each run exactly 24 times; denied requests do not construct
controllers or enter interceptors. The Nitro close hook logs that the application injector was
destroyed.

## Limits and release gates

The profile uses one pass-through interceptor; it does not qualify two-interceptor ordering,
response mapping, `next()` misuse, schema transformations, malformed/oversized JSON, error
precedence, constructor/provider failures or deliberate negative controls. It has no measured
server/browser bundle comparison or private-canary source-map scan. Workerd and active-request
shutdown are not qualified here. The existing Angular JIT workerd NO-GO remains in
force; this Node-only fixture does not alter Worker support. Shared SSR/server-function/controller
injectors, real production adoption and Strata 1.0 remain unqualified.

No package runtime/public API changed, so no Changeset is needed. No package was published and no
Cloudflare deployment ran. The focused command is `pnpm test:analog-packed-di-consumer`.
