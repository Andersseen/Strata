# Analog validated URL-encoded forms (0.10.0 candidate)

This report records the next increment for `@strata-sc/analog`. Evidence levels are separated: the API is implemented and unit-tested; the real fixture passed Node production, Vite development and local workerd; the packed consumer passed outside the workspace. Hosted-CI and deployed evidence are still pending.

- **Starting `main`:** `68e4a5135964e3ea6f8f86ef216baa969fe4e429` (PR #127 version commit; `@strata-sc/analog` 0.9.0).
- **Branch:** `feat/analog-validated-forms-v010`.
- **Expected release:** one minor Changeset for `@strata-sc/analog`, 0.9.0 → 0.10.0. No other package version is changed; no package has been published, tagged or deployed from this branch.
- **Dependency tuple:** Analog platform / Angular Vite plugin 2.7.2; Analog router 2.8.1; Nitro 2.13.4; H3 1.15.11; Vite 8.3.0; Angular fixture core/compiler 22.1.7, common/platform-browser 22.2.3, platform-server/router 22.2.2; TypeScript 6.0.3. Local workerd used Wrangler 4.135.0, compatibility date 2026-09-21. Runtime command used Node 22.23.1.
- **New dependencies:** none. `@standard-schema/spec` remains 1.1.0.

## Gap and API

`readBody()` already used `URLSearchParams` for URL-encoded data but was an unchecked, unbounded raw reader. Before this change there was no opt-in Standard Schema validation and bounded-body contract for native HTML form submissions.

```ts
readValidatedForm<Schema extends StandardSchemaV1>(
  schema: Schema,
): Promise<StandardSchemaV1.InferOutput<Schema>>
```

The method reuses `validateSchema()`: inferred output, transformations, sync/async schemas, schema metadata checks, malformed-result handling and existing safe 400 translation. It introduces no validator runtime dependency. The method remains explicit per controller; it does not add route-wide or automatic validation.

## Parsing, media type and limits

Only `application/x-www-form-urlencoded` is accepted, compared case-insensitively. Other media types, multipart included, answer 415. The default charset is UTF-8. No declaration or one `utf-8` / `utf8` declaration is accepted (case-insensitive, quoted or unquoted); unsupported, malformed or duplicate charset parameters answer 415. Other media type parameters are ignored.

The parser uses the platform `URLSearchParams` only after narrow strict checks:

- `+` and `%20` mean space; `%2B` means literal plus.
- Percent escapes decode bytes as UTF-8. `%26` and `%3D` remain within the key or value because parsing separates only on literal `&` and the first literal `=`.
- A single field is a string; repeated values form an ordered string array. Missing fields are absent. Empty values and empty keys are retained. Empty segments from consecutive `&` are ignored.
- Raw and percent-encoded Unicode decode as UTF-8. `%00` is retained as NUL. No numeric/boolean coercion occurs. Bracket and dotted names remain literal.
- `__proto__`, `constructor` and `prototype` are assigned as own properties with the same safe `Object.defineProperty` helper used by query parsing.
- Malformed percent escapes, invalid percent-encoded UTF-8, and invalid raw UTF-8 answer 400. A check with `decodeURIComponent` runs before `URLSearchParams`, whose native forgiving decoder would otherwise replace invalid input.

The body is capped at 1 MiB of actual consumed bytes, using the same bounded reader as validated JSON. `Content-Length` is not trusted. More than 10,000 non-empty form fields also answers 413 to cap parser amplification; empty `&` segments do not count. Both conditions use `{ "error": "payload_too_large", "source": "body" }`. Malformed input returns `{ "error": "invalid_request", "source": "body" }`; unsupported media type or charset returns `{ "error": "unsupported_media_type", "source": "body" }`. All expected errors are JSON UTF-8 with `Cache-Control: no-store` and contain no input or schema detail.

## Body ownership, cleanup and observation

One request-local body state is shared across readers. An unbounded raw reader first makes either validated body reader a configuration error. After a validated read, raw readers reuse the validated, bounded text. Repeated or concurrent calls to one validated method share the same read and validate the same parsed input; `readValidatedJson()` and `readValidatedForm()` cannot reinterpret one another's body. Raw `readBody()`, `readText()` and `readJson()` otherwise keep their old unchecked contract.

Schema issues, malformed form encoding, an oversized body and unsupported media types retain the existing `StrataAnalogInputError` lifecycle. Cleanup settles before expected errors translate. A cleanup failure retains precedence and is observed as `cleanup-failed`; it is not turned into the safe 400. Validator throws/rejections remain application failures, not input rejections. The existing observation union is unchanged; valid form is `completed`, expected form rejection is `input-rejected`, and no form value is included in observation data.

Validation is not CSRF protection or authentication. A state-changing form endpoint needs a consumer-owned CSRF/origin policy suited to its authentication model. Form fields named `userId`, `tenant`, `role` or `principal` are untrusted input; Strata adds no sessions, credential verification or identity trust.

## Qualification evidence

**Unit tested:** the Analog package suite passed 241 tests, including Zod, Valibot and handwritten Standard Schema v1 usage; inferred transformed output; async validation; missing/empty/repeated fields; ordered repeats; literal and dangerous keys; spaces, plus, encoded delimiters, Unicode, NUL, malformed percent/UTF-8; 1 MiB/one-byte-over; misleading `Content-Length`; reader ordering/reuse/conflict/concurrency; safe errors; and request isolation. Existing JSON tests remain enabled. Release-gate decision tests passed 17 adversarial cases.

**Locally integrated:** `pnpm test:analog-forms` passed on Node production, Vite dev and local Cloudflare Pages/workerd (Wrangler 4.135.0). Each runtime verified successful transformation and repeated fields, safe validation errors, malformed percent/UTF-8, 413, 415, 24 overlapping requests, cleanup and observation order, cleanup-failure precedence, native Nitro route coexistence, unrelated endpoint behavior and absence of unhandled promise rejections. The local workerd result is not a deployed qualification. The fixture does not execute serverFn in this new suite; existing serverFn and SSR suites remain separate regression gates.

**Confidentiality checks:** synthetic values in form content, authorization and cookies were absent from expected validation responses and stored observations. No request-body logging was added. The packed-consumer check passed with TypeScript 5.9.2 and 6.0.3 and exercised the transformed form API from an npm tarball outside the workspace in Node. The real fixture's browser console, full built asset and source-map canary scans passed; it has no browser form flow because parsing is server-side.

**Not yet qualified:** hosted pull-request CI, live workflow-run transitions, and deployed Cloudflare behavior. Local checks cannot establish GitHub's post-merge `workflow_run` transition, and no Cloudflare deployment was run.

## Issue #117: exact-CI release gate

At the starting SHA, Release run `40120642476` completed successfully on the merge of PR #127 and GitHub Release `@strata-sc/analog@0.9.0` exists. A read-only npm registry query confirmed `@strata-sc/analog@0.9.0` was published. The previous workflow had no dependency on aggregate `Verify`; issue #117 remains open until the new gate is merged and live-tested.

The release workflow is changed to `workflow_run` after CI completion. A trusted default-branch authorizer verifies the initiating repository, CI workflow path/name, push event, main branch, completed successful run, source/head repository IDs, exact run's single successful `Verify` job and that the run SHA still equals `main`. It checks again immediately before Changesets runs. It checks out only the authorized SHA. The release job alone retains write/provenance permissions and `NPM_TOKEN`; Version Packages PR handling, provenance, dist-tag synchronization and post-publish registry consumer remain in place. No manual trigger is configured.

`tools/release/lib/verify-run.test.ts` covers success; failed, cancelled, pending, missing and duplicate Verify; SHA mismatch; pull request; non-main branch; fork; unrelated workflow; stale main; API error; non-completed trigger; and repeated invocation. These are local decision-function tests, not live GitHub `workflow_run` transition evidence. Hosted CI after a PR and the post-merge push-to-CI-completion transition must be inspected before issue #117 can be closed.

## Remaining gates

- **M3:** stable controller metadata and member semantics, full external-consumer type/runtime closure, explicit authorization/CSRF practice, broader real applications and a supported integration matrix remain open.
- **M4:** Server Component production graph, error/navigation and adoption gates remain open. This Analog form change does not affect that work.
- **M5 / 1.0:** production release candidate, deployed qualification and adoption remain open. No production support or adoption is claimed.

## Check record

- PASS: Analog unit suite (241).
- PASS: release eligibility unit suite (17).
- PASS: real Analog form fixture, Node production / Vite dev / local workerd.
- PASS: full local CI workflow matrix, including package tests, static checks, server-component Node/workerd contracts, packed consumers, Cloudflare local workerd, website and Relay Playwright suites.
- PASS: `pnpm test:server-component-deployment-skew` (Node and local workerd).
- PASS: `pnpm test:full-stack-deployed-cloudflare` source-packed local rehearsal; no public deployment was requested or performed.
- PASS: package-release and dist-tag dry-runs. The package dry-run found all three current versions already on npm; npm scope preflight reported E401 because this environment has no authenticated npm identity. No publish or tag mutation was attempted.
- NOT REPRODUCIBLE LOCALLY: Entwine validation (`entwine` is not installed; `pnpm exec entwine context --json` returned command not found).
- PENDING: hosted pull-request CI and post-merge workflow-run transition; deployed qualification.
