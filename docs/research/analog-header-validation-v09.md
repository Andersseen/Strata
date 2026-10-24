# Analog header validation (0.9.0 candidate)

Evidence for `request.validateHeaders(schema)` in `@strata-sc/analog`: opt-in Standard Schema v1 validation of a
deterministic, request-local header snapshot. Implemented, unit tested, locally integrated (Node, Vite dev, local
workerd) and packed-consumer type-qualified. Not hosted-CI qualified when this was written, not deployed, not
production adopted, and not M3 or Strata 1.0 certification.

- **Starting `main`:** `769899ce43549341bacaa5ca90866cc620966bb3` (merge of PR #125, Analog 0.8.0), branch
  `feat/analog-header-validation-v09`. One minor Changeset targets `@strata-sc/analog` (expected 0.9.0); no version
  is edited by hand and nothing is published, tagged or deployed from the branch. `@strata-sc/core`,
  `@strata-sc/server-components` and `@strata-sc/h3` are untouched.
- **Runtime tuple (lockfile unchanged):** Nitro 2.13.4, h3 1.15.11, Vite 8.3.0, Angular 22.1.7 (fixture), Wrangler
  4.135.0 on local workerd (compatibility date 2026-09-21), TypeScript 6.0.3.

## API

```ts
type StrataAnalogHeaders = Readonly<Record<string, string>>;
validateHeaders<Schema extends StandardSchemaV1>(schema: Schema): Promise<StandardSchemaV1.InferOutput<Schema>>;
```

It reuses the existing `validateSchema` path, so metadata checks, malformed-result handling and the safe-failure
contract are shared with `validateParams`, `validateQuery` and `readValidatedJson`. No new dependency; no Zod or
Valibot at runtime. `StrataAnalogInputError.source` gains `"headers"`.

## Snapshot semantics

The schema input is built from the request's native `Headers` (already created per request by `getEventHeaders`)
at call time: a new object per call, own properties only (`Object.defineProperty`, so a key such as `__proto__`
cannot change the prototype), frozen, never shared between requests, and `request.headers` is not mutated.

- **Names** are lowercase because the native `Headers` iterator lowercases them.
- **Values** are strings; there is no numeric/boolean coercion and no splitting.
- **Repeated fields:** the native `Headers` already combines them with `", "`; the snapshot keeps that exact text
  (tested: `append("x-dup","one")` + `append("X-Dup","two")` yields `"one, two"`). Distinct entries that
  `Headers` still yields separately (only `set-cookie` on runtimes that expose it) are joined with `", "` too.
  Original per-line fidelity is therefore not available through the schema; `request.headers` stays the access path
  and no second raw-header API is added.
- Commas, colons and non-ASCII values the platform accepts are preserved verbatim.
- `authorization`, `cookie`, `forwarded`, `x-forwarded-*` and signature headers are not parsed. Proxy-supplied
  forwarding fields are not authenticated identity.

## Failures

| Situation                                   | Result                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Schema issues                               | `400`, `application/json; charset=utf-8`, `no-store`, `{"error":"invalid_request","source":"headers"}` |
| Malformed Standard Schema metadata / result | configuration error (not a 400)                                                                        |
| Validator throws or rejects                 | application failure, observed as `failed` (not a 400)                                                  |
| Cleanup callback fails after a rejection    | cleanup failure wins (500), observed as `cleanup-failed`                                               |

Header values, credentials, issue messages and causes never enter the response or an observation (canaries for
`authorization`, `cookie`, a custom header and a schema message are asserted absent). No 431 policy is added: header
size limits belong to the host transport and are not advertised as Strata's. 413/415 body behavior is unchanged.

## Qualification

- **Unit** (`packages/analog/src/header-validation.test.ts`, 12 tests; the package suite is 238 passing): mixed-case
  names, missing/empty/over-long values, optional header, unknown extra headers, commas/colons/unicode, repeated
  fields, Zod/Valibot/handwritten schemas with inferred types, transformation, async accept/reject, malformed
  metadata, throw/reject/malformed result, safe 400, canary redaction, cleanup, cleanup precedence, interceptor
  visibility, `onRequestSettled` classification (`input-rejected`, `cleanup-failed`, `failed`, `completed`),
  `__proto__`-style keys, snapshot isolation and 24 overlapping requests with distinct headers.
- **Real Analog fixture** (`pnpm test:analog-headers`, 66 checks, 0 failing on Node production, Vite dev and local
  workerd): transformed success, missing and invalid headers, async validation, throwing validator, cleanup before
  observation, 24 overlapping mixed requests with distinct canaries and no value in any observation; native Nitro
  routes, `serverFn`, the API boundary and SSR unchanged (workerd keeps its pinned `serverFn` NO-GO). In dev, Nitro's
  own error page echoes a thrown message; that host behavior is why the throwing-validator body check is skipped
  for dev only.
- **Packed consumer:** `pnpm test:full-stack-package-consumer` compiles a `validateHeaders` handler (inferred
  `number` from a transform) against the installed tarball under strict TypeScript with `skipLibCheck: false`.

## Release safety and readiness

- Issue #117 is open: `release.yml` still has no gate on a successful aggregate `Verify` of the same SHA. On
  `769899c` the Release workflow succeeded while CI failed. Publishing 0.9.0 is not qualified until it is fixed.
- A flaky Cloudflare qualification (`test:server-components:cloudflare` attributed the second `/_worker.js` probe's
  expected NG04002 log line to the direct load) failed `main`'s CI; this branch fixes the harness race in a
  separate commit.
- M3 is not complete; nothing here is deployed or production adopted. NO-GO conditions are unchanged (client
  disconnect, `serverFn` on workerd, H3 v2 declarations, #117).
