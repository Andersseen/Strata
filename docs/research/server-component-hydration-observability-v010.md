---
type: research
---

# Server Component hydration observations (0.10.0 candidate)

## Candidate and dependency tuple

Starting `origin/main` SHA: `efd14e2d1375e1762846c3ee6ab6bb49d5440609`, package
`@strata-sc/server-components` 0.9.0. Candidate branch:
`feat/server-components-hydration-observability-v010`.

The fixture lockfile tuple is Analog platform / Angular Vite plugin 2.7.2, Analog Router 2.8.1,
Angular core/compiler/compiler-cli 22.1.7, common/platform-browser 22.2.3, platform-server/router
22.2.2, Angular build 22.1.8, Nitro 2.13.4, H3 1.15.11, Vite 8.3.0, TypeScript 6.0.3,
Node 22.23.1 and Wrangler 4.135.0. These mixed lockfile resolutions are a fixture tuple, not a
compatibility promise.

## Public API and event

```ts
import { provideStrataHydrationObserver } from "@strata-sc/server-components";

provideStrataHydrationObserver((event) => {
  applicationLogger.info("strata-host", event);
});
```

`StrataHydrationObservation` is readonly and frozen at delivery:

| Field                  | Contract                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| `hostSelector`         | Public selector of the generated Server Component host element.                |
| `outcome`              | `committed`, `preflight-refused`, or `commit-failed`.                          |
| `discoveredBoundaries` | Number of boundary elements discovered for this host.                          |
| `committedBoundaries`  | All discovered boundaries on success; zero on refusal or rollback.             |
| `failureCategory`      | Existing `BoundaryFailureCategory` on a classified preflight refusal only.     |
| `buildMismatch`        | True only for `StrataBuildMismatchError` from two valid, different identities. |
| `recoveryOutcome`      | Existing bounded recovery result, present only for confirmed mismatch.         |
| `elapsedMs`            | Monotonic duration of discovery, preflight, commit, and rollback if needed.    |

Provider scope is the Angular application injector. There is no server request context or required
initialization call. With no provider, the event and clock read are skipped. The existing boundary
discovery remains the sole scan.

## Outcome semantics

One `afterNextRender` callback owns one host attempt. A successful event follows all roots being
created, inputs assigned, views attached, and hydrated markers written. An empty host is a successful
zero-boundary transaction and reports `committed` with both counts zero. Preflight is all-or-nothing;
a refusal is reported before the existing error throw and before component creation. Commit failure
is reported only after created roots have been destroyed and SSR nodes restored, then the original
error is thrown unchanged. Each eligible attempt reports at most once. A host destroyed before its
scheduled callback starts reports nothing; destroy after an attempt does not emit another event.

`preflight-refused` may contain an existing category. Arbitrary errors during root creation or input
assignment use `commit-failed` without a fabricated category. No event means successful completion of
all later Angular change detection, event handlers, requests or deferred rendering.

## ErrorHandler and skew recovery

Strata still registers no ErrorHandler, calls no ErrorHandler and does not wrap a component error.
Angular receives the exact error once through the same `afterNextRender` error path. Observer sync
throws are caught. Returned promises and thenables are not awaited and have rejection handlers
attached immediately. Their failures cannot alter rollback, sibling hosts, ErrorHandler delivery or
recovery.

Only a confirmed `StrataBuildMismatchError` is passed to `SkewRecovery`; malformed/missing identities,
protocol errors and all other boundary categories are not eligible. The event reads the error's
existing recovery outcome after `handle()`. Recovery stays disabled unless opted in, keeps its
existing per-tab bound, and invokes the existing `onMismatch` callback. A synchronous reload request
may begin before application telemetry side effects finish; no external delivery is promised during
navigation. Multiple mismatched hosts remain under the existing document-level reload decision.

## Confidentiality and timing

The flat event contains no props, component values, URL, query, cookies, authorization, request body,
resource or tenant ID, exception, DOM node, injector or Angular reference. Build labels are not copied
into the event. `elapsedMs` covers Strata's boundary discovery, validation, component creation, input
assignment, view attachment, marker update and any rollback. It excludes network time and later
Angular work. This is not a measure of Angular's full hydration lifecycle.

## `@defer`

The host event means Strata's explicit client roots committed. Angular continues to own `@defer`,
including viewport / interaction triggers, lazy chunks and event replay. A deferred child may still be
dehydrated when the host is reported; its later hydration does not create another Strata host event.
Deferred blocks remain unsupported in server-owned templates.

## Evidence matrix

| Evidence level            | Status                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Implemented               | Provider, readonly type, host outcome integration, failure isolation.                                 |
| Unit tested               | Provider scope, no-observer path, frozen shape, sync throw, rejected Promise and thenable (354 pass). |
| Locally integrated        | Node, Analog live dev, workerd, failure/recovery, deployment-skew and `@defer` suites passed.         |
| Packed-consumer qualified | Packed tarball install, TS 5.9/6, Node production, external dev and Cloudflare/workerd passed.        |
| Hosted-CI qualified       | Not established; GitHub Actions run access was unavailable during this pass.                          |
| Deployed qualified        | Not run; no real deployment was authorized.                                                           |
| Production adopted        | Unknown / not evidenced.                                                                              |

The Changeset is one minor bump for `@strata-sc/server-components`; no version files were edited.
One Node fixture observation reported 1.10 ms for one host attempt, including boundary scan,
preflight and commit. This is one noisy sample, not a comparative overhead benchmark. The disabled
path skips event allocation and clock reads; its comparative cost has not been measured. Full workspace
build, typecheck and tests passed; the performance-tools subset passed 163 checks with loopback access.
Repository-wide lint still reports unsafe typing diagnostics in existing `apps/relay` files; the full
lint command has not produced a clean result for this branch.

## Release safety and remaining limits

The current release workflow is a `workflow_run` workflow and calls `tools/release/authorize.ts` before
any version or publish action. `verify-run.ts` requires a completed successful CI run for a main push,
a single successful aggregate `Verify` job, and that main still points at that exact SHA. The helper
tests cover successful, failed, cancelled, pending, missing/duplicate Verify and GitHub's reported
workflow path. Issue [#117](https://github.com/Andersseen/Strata/issues/117) remains open. Recent hosted
runs and live pending/failure/cancelled/stale-main transitions could not be inspected through the
available GitHub Actions API in this environment; do not claim release workflow qualification or
close the issue based on the helper tests alone. No package was published.

This feature does not complete M3, M4, M5 or Strata 1.0. Browser Router subtree navigation, protocol
stability, deployed qualification, full supported-version matrix, production application adoption and
the remaining release safety evidence are still separate gates.
