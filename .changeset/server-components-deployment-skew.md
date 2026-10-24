---
"@strata-sc/server-components": minor
---

Add an opt-in application build identity so a browser can tell that the Server Component document it received and the script it runs come from different deployments, and an opt-in, bounded recovery for that one case. The boundary protocol numbers (`1`/`2`) are unchanged and cannot say whether the application contract is: a client component's inputs or implementation can change while the protocol stays the same.

`strataServerComponents({ buildId })` takes a consumer-chosen label (1–64 characters of `A-Za-z0-9._:+-`, public, never a secret) and compiles it into every environment of that build as one constant. Each server-rendered client boundary then carries `data-strata-build`, and before any `ComponentRef` is created the browser compares it with its own. Without the option nothing is stamped or enforced and existing v1/v2 applications behave exactly as before; an older browser script ignores the attribute (it cannot detect a mismatch it predates).

`StrataBoundaryError` now has a stable `category` (`serialization`, `metadata`, `protocol`, `props`, `reference`, `inputs`, `build-identity`, `build-mismatch`), and `StrataBoundaryError` and the new `StrataBuildMismatchError` (with `browserBuildId`, `serverBuildId` and `recovery`) are exported. Only two well-formed, different identities are a `build-mismatch`; a missing or malformed identity is `build-identity` and is never treated as a deployment. Per-host all-or-nothing preflight, sibling isolation, rollback and the untouched server-rendered DOM are unchanged, and the error still reaches the application's `ErrorHandler`.

`provideSkewRecovery({ reload, maxReloads, windowSeconds, onMismatch })` adds the opt-in policy: `onMismatch` receives the two public build ids, and `reload: true` reloads the current document at most once per tab and five-minute window by default (1–3 / 30–3600 s), counted in `sessionStorage` before the reload and read back. Blocked or forgetful storage, or an implausible record, means no reload. No other failure (protocol, props, selector, input, constructor, missing or malformed identity) ever reloads.

Qualified with `pnpm test:server-component-deployment-skew`: independently built releases of an external consumer installed from the packed tarball, a document of one served with the script of another, on Nitro Node and local workerd (not a deployed Pages project). The first deployment of this feature cannot repair clients that already run an older script.
