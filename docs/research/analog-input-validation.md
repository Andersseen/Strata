# Analog Standard Schema HTTP input validation

## Scope and decision

Baseline: `41079a32e84f5c8d652fee04d212801571cb97f4` (`main`, synchronized with
`origin/main` on 2026-10-17). The feature branch is
`feat/analog-standard-schema-validation`.

The public request API is `validateParams(schema)`, `validateQuery(schema)` and
`readValidatedJson(schema)`. These methods return `StandardSchemaV1.InferOutput`
from the schema, so schema transformations are retained. They are always
awaitable and support synchronous and asynchronous validators. Existing raw
request properties and readers remain available. `readJson<T>()` is unchecked.

Standard Schema v1 is the supported contract. The public type dependency is
`@standard-schema/spec@1.1.0`; production code has no Zod, Valibot or ArkType
runtime dependency. Tests use independent Zod and Valibot implementations.
An absent/malformed `~standard` object, unsupported version, missing validator,
or malformed result is a configuration/programming error. A validator throw or
rejection propagates as an unexpected application failure. An issue result is
an invalid-client-input error; issue text is never returned to the client.

Rejected alternatives: per-library adapters or a runtime schema-library
dependency; parameter decorators; unchecked user-selected output generics;
global validation middleware; replacing the existing params/query/body APIs.

## Input semantics

- Params are a snapshot of Nitro's matched, URL-decoded string params. The raw
  `request.params` stays available.
- Query values remain strings when singular and arrays when repeated. Numeric
  coercion is schema-owned. Empty query objects work. Params/query record writes
  use own properties for `__proto__`, `constructor` and `prototype` while
  preserving ordinary object prototypes.
- JSON content types accepted: `application/json` and `application/*+json`;
  charset may be absent or UTF-8. Empty content validates as `undefined`.
- Maximum validated body size is 1 MiB, measured in consumed bytes. A stream is
  stopped at the limit; buffered bodies are checked before decoding/parsing.
  Invalid UTF-8 and malformed JSON return 400. Unsupported media type/charset
  returns 415; oversized input returns 413. Content-Length is not trusted.
- Call `readValidatedJson` before raw body readers. Once it reads the bounded
  body, raw readers reuse its request-local text. If a legacy raw reader ran
  first, validated reading throws a configuration error because the stream may
  already have been consumed without the bound. No request cache is shared.

| Status | Body                                                         | Condition                               |
| ------ | ------------------------------------------------------------ | --------------------------------------- |
| 400    | `{"error":"invalid_request","source":"params\|query\|body"}` | schema issue or malformed JSON/encoding |
| 413    | `{"error":"payload_too_large","source":"body"}`              | more than 1 MiB consumed                |
| 415    | `{"error":"unsupported_media_type","source":"body"}`         | unsupported media type/charset          |

All such responses use `application/json` and `Cache-Control: no-store`, with
no issue text, stack, request value, file path, cause or aggregate details.
Unrelated handler and validator errors are not translated. Translation occurs
only after `CleanupScope.close` succeeds. Cleanup failure preserves existing
single-error/AggregateError semantics and takes precedence over a safe 400.
Successful `Response` values pass through unchanged.

## Evidence

Local verification on the feature branch:

- `pnpm --filter @strata-sc/analog typecheck`, `test` (100 tests) and `build`
  pass. Tests cover Zod and Valibot schemas with transformations, explicit
  output assignments, synchronous/asynchronous validators, safe failures,
  cleanup precedence, 1 MiB limits, unsupported charset, dangerous record keys,
  false Content-Length, split UTF-8 and 24 overlapping requests.
- `pnpm test:analog` passes 84/84 checks. Nitro node-server production and the
  real dev server both exercise params/query transforms, async JSON transform,
  safe 400 response and 24 overlapping mixed valid/invalid requests with unique
  params, query tags, JSON correlation ids and private canaries.
- `pnpm test:server-components:cloudflare` passes on the fixture's
  `cloudflare-pages` preset with local Wrangler/workerd. It exercises the same
  transforms and 24 overlapping mixed validation requests, checks safe errors
  and canary absence, and retains the native Nitro route controls.
- `pnpm test:package-consumer` passes with packed tarballs installed outside the
  workspace. Strict TypeScript 5.9.2 compilation resolves the Standard Schema
  type from the package dependency; Node runtime validation returns the
  transformed result and safe 400 without a symlink or source alias.
- `pnpm test:full-stack-package-consumer` passes with strict TypeScript 6.0.3
  and 5.9.2; its consumer compile includes an explicit transformed params
  output assignment against the packed declarations. Node and workerd full
  stack checks pass.
- `env -u STRATA_FULLSTACK_DEPLOY -u STRATA_FULLSTACK_DEPLOYED_URL
-u STRATA_FULLSTACK_REQUIRE_DEPLOYED -u CLOUDFLARE_API_TOKEN
-u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_KEY pnpm
test:full-stack-deployed-cloudflare` passes local build and workerd rehearsal;
  its verdict records **REAL DEPLOYMENT: NOT RUN**.

Negative controls include issue-message/canary non-disclosure, invalid params
preventing handler success, a validator throw retaining the existing 500 path,
cleanup failure preventing safe-400 translation, false Content-Length failing
the byte-bound check, and per-request swapped-data detection in both real
runtime concurrency verifiers. A deliberately absent validation call remains
an opt-in behavior and is demonstrated by the backward-compatible unvalidated
controllers in both packed consumer suites.

## Limitations

This is an opt-in HTTP input boundary only. Authentication and authorization
are not provided; guards/interceptors are not implemented. Unexpected SSR
failures are outside the contract. No production application has adopted this
API. M3 and Strata 1.0 are not fully qualified. There is no multipart or
streaming-response support, and the 1 MiB limit is currently fixed.
