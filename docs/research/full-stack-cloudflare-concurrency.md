# Full-stack Cloudflare: controller concurrency anomaly

Date: 2026-10-15  
Starting `main`: `05fb1626f712c17ea9b1cfb62efcd63d8fde547a`  
Branch: `test/cloudflare-controller-concurrency`

## Verdicts first

| Verdict                                                          | Result                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Root cause of the historical anomaly (run 38727456938)           | **UNCONFIRMED**                                                                                                                |
| Historical anomaly reproduced anywhere                           | **NOT REPRODUCED** (local Node, local workerd, existing public deployment, new public deployment)                              |
| Controller request isolation (adapter code audit and all runs)   | CONDITIONAL GO: no cross-request state found in the adapter, no mismatch observed; a cause for run 2 remains unconfirmed       |
| Local Node concurrency                                           | GO (829 requests, 0 anomalous)                                                                                                 |
| Local workerd concurrency                                        | GO (829 requests, 0 anomalous)                                                                                                 |
| Deployed concurrency, existing deployment `b1fb974c` (read-only) | GO (478 requests, 0 anomalous; artifact predates the correlation route)                                                        |
| Real full-stack Cloudflare qualification of **this candidate**   | GO: [run 38741663534](https://github.com/Andersseen/Strata/actions/runs/38741663534), deployment `0a77889b`, every check green |
| Historical runs 38722004014 and 38727456938                      | remain **NO-GO**; they are not rewritten                                                                                       |
| Production authentication / tenant-aware caching                 | NOT QUALIFIED                                                                                                                  |
| Shared controller/Angular SSR DI                                 | NOT QUALIFIED                                                                                                                  |
| True SPA Server Component navigation / streaming SSR             | UNSUPPORTED                                                                                                                    |
| Strata 1.0                                                       | NOT YET QUALIFIED                                                                                                              |

A green run on one candidate does not erase the earlier failure and does not close the 1.0 deployment
criterion: it covers a source-packed fixture, not a real application.

## The original failure (run 38727456938)

Commit `16da4115df75f05c3569369cb9dd7f66bec23668`, deployment `b1fb974c`
(`https://b1fb974c.strata-fullstack-qualification.pages.dev`). Controller round "25 concurrent": requests
alternate `/api/products/42`, `/7`, `/999` (index mod 3), so the expected distribution is **17 × HTTP 200,
8 × HTTP 404**. Observed **16 × 200, 9 × 404**, `succeeded 24 / failed 1`, `crossRequestAnomalies 1`, max
latency 242.1 ms (about the whole wall time of the round, 242.9 ms). Every other round, including 25
concurrent Server Component documents, was clean.

What the recorded numbers imply: one request that should have returned 200 returned 404. The status check and the
body check both failed once (`failed 1`, `1 anomalous`), which is consistent with any 404 body, and the
gate then recorded no body. Hence the runner of that time could not tell the cases below apart.

Readiness in the same run (artifact): attempts 3, 5 and 6 of the page probe returned an **HTML 404 with
`server: cloudflare`** (no controller fingerprint) while attempt 4 and the later attempts returned 200. So
the same deployment demonstrably answered with intermittent edge-looking 404s shortly after it was
created. That makes an edge-side 404 a **plausible** explanation. It is not proven: the anomalous response
was not captured.

Run 1 (38722004014), for completeness: all 40 readiness attempts `fetch failed` (no cause recorded then),
build digest `70ce5950184044a068b3596405eff619e2cd143dc27f097570c336c2b2aab37c`, deployment
`d1217a16-4829-4cf6-941f-1de71e0ab786`, tested commit `137143dac9a92d3e1e4f31a281893fa6d176c878`. It never
reached a functional verifier.

## Candidate causes and what excludes or keeps each

| Candidate                                    | State after this increment                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare edge / propagation                | **Plausible, unconfirmed.** Same-deployment intermittent HTML 404s from `server: cloudflare` were recorded during readiness; no anomaly after warm-up (1500 requests probe, 478 + 829 requests here).                                               |
| Nitro/H3 routing or response handling        | Not reproduced on Node or workerd (829 requests each, rotated order, bursts, mixed traffic). Not excluded for an edge isolate.                                                                                                                      |
| Strata Analog controller adapter             | Code audit below found no shared mutable state. Not reproduced. Not excluded by absence of reproduction.                                                                                                                                            |
| Request-context / controller-instance mixing | The correlation route would expose it (resource and correlation id must be the sender's). Never observed. The adapter creates a new instance per request.                                                                                           |
| Qualification runner / assumptions           | Reviewed: expected status derived from `index % 3`, baselines fetched before, no shared test state across requests. The comparator was correct; its limitation was that it **discarded the anomalous response**. That is what this increment fixes. |
| Transport error                              | Excluded for this one: the status counts sum to 25 and `network-error` is absent, so a response was received.                                                                                                                                       |

## Adapter audit (`packages/analog/src/register-controllers.ts`)

Runtime path: Nitro router → registered Strata route → H3 v1 event → `createStrataAnalogRequest(event)` →
`controllerFactory` → handler method → Web `Response` → Nitro.

- Nothing mutable lives at module scope in the adapter besides the registration `WeakMap` (keyed by router,
  touched only at registration, never per request).
- Every request builds its own `URL`, `Headers`, frozen `params` (copied from `event.context.params`), `query`,
  `context` snapshot and `CleanupScope` inside the route handler closure; the controller instance is created
  per request by the factory and dropped. Handler is invoked as `handler.call(controller, request)`.
- `event.context.params` is owned by the event, which Nitro creates per request. Nothing in the adapter
  caches an event, URL or params.
- Installed versions in the candidate: nitropack 2.13.4, h3 1.15.11 (H3 v1; behavior was not inferred from
  v2). No private runtime API is used.

Conclusion: request A cannot observe request B's path, params, headers, instance or result through Strata's
code. This is a code-reading conclusion plus the runs below; it is not a proof about Nitro or workerd.
No adapter change was made and no Changeset is needed.

## What changed (test and diagnostic code only)

1. `tools/server-components/lib/response-classification.ts`: classifies any non-matching answer as
   `controller-response-mismatch`, `edge-response`, `transport-error` or `unclassified` (diagnostic
   categories, not root causes). Each sample records target, expected/actual status and content type,
   expected/observed public subject and correlation id, controller-fingerprint presence, safe edge headers
   (`server`, `cf-ray`, `cf-cache-status`, `age`, content type/length, `location`, `cache-control`), a
   body prefix limited to 160 characters, elapsed time and the transport error code. A body containing a
   synthetic private value is withheld and fails the gate. No cookies, authorization or environment values
   are ever captured.
2. `tools/server-components/lib/full-stack-remote.ts`: the existing 80-request smoke now stores these
   samples (and, new, samples for transport errors, which were previously only counted). Its assertions are
   unchanged.
3. Fixture-only `QualificationController` (`GET /api/qualification/:resource?cid=…`, resources `alpha`,
   `beta`, `gamma`; `cid` bounded to `[a-z0-9-]{1,48}`): the answer echoes resource, `cid` and path. The id is an
   untrusted label, never authentication; no production API is added; `/api/products` is untouched.
4. `tools/server-components/lib/concurrency-matrix.ts` and `pnpm test:full-stack-cloudflare-concurrency`
   (`tools/server-components/cloudflare-concurrency.ts`): deterministic, bounded (hard ceiling 1500
   requests per URL, enforced in code) matrix: post-readiness burst, sequential baseline, 10 and 25
   concurrent, ten repeated 25-bursts with rotated order, reversed order, stabilization interval,
   controller-only and combined controller + Server Component traffic, products and correlation sets
   (mixed 200/404 by construction). It records matched count, classes, statuses, expected vs unexpected
   404, body mismatches, network errors, latency percentiles and the first bounded samples. It does not
   deploy, requires the isolated project's hostname, and says `REPRODUCED` / `NOT REPRODUCED` and
   `root cause: UNCONFIRMED`. If the correlation route is absent from a deployed artifact (an older
   deployment), it is recorded as absent and those rounds are skipped, never counted as passes.
5. The full deployed qualification runs the same matrix and folds it into "bounded concurrency".

No performance budget, retry or tolerance was added: a failed request is never retried or reclassified as a
success.

## Negative controls

Loopback fault-injecting stub (`lib/fault-stub.ts`), run on every invocation of the command:

| Stub fault  | Required outcome                                              | Result |
| ----------- | ------------------------------------------------------------- | ------ |
| `honest`    | 0 anomalies, correlation route detected                       | pass   |
| `swap`      | every answer carries the previous request's body: caught      | pass   |
| `wrong-cid` | correlation id is not the sender's: caught                    | pass   |
| `edge-404`  | Cloudflare-looking HTML 404: classified `edge-response`       | pass   |
| `wrong-404` | controller 404 JSON for a 200 request: classified as mismatch | pass   |
| `drop`      | destroyed connection: classified `transport-error`            | pass   |
| budget      | a 20-request budget aborts the matrix at 20 requests          | pass   |

Plus classifier unit controls (exact match, wrong resource, wrong correlation id, controller 404 for 200,
HTML edge 404, Angular HTML fall-through as `unclassified`, transport error code, private-value withholding,
bounded body prefix).

## Results

### Local Node and local workerd (this checkout, loopback)

`pnpm test:full-stack-cloudflare-concurrency` on `d65321606ecfd94457f1de277ebd9792c3e5ec21` (Node v22.23.1,
source-packed candidate; nitropack 2.13.4, h3 1.15.11, wrangler 4.135.0):

| Target  | Requests | Matched | Anomalous | Verdict | Anomaly        |
| ------- | -------: | ------: | --------: | ------- | -------------- |
| node    |      829 |     829 |         0 | GO      | NOT REPRODUCED |
| workerd |      829 |     829 |         0 | GO      | NOT REPRODUCED |

Loopback latency is not edge latency; no budget is implied.

### Existing public deployment, read-only

`https://b1fb974c.strata-fullstack-qualification.pages.dev` (the deployment of the failed run 2) still
answered 200. Nothing was deployed. It predates the correlation route (it returned the Angular HTML
fall-through, the known limitation), so only the products, Server Component and combined rounds ran:
**478 requests, 0 anomalies**, readiness reached after 5 attempts. The identity of that artifact was not
re-verified by this run; it is taken from run 2's evidence (commit `16da4115…`, build digest
`10cf3cd4f0bd710254f29fab1d94932f70485d592ed3b2d5d091c07c5eeab70f`).

### New remote qualification (one dispatch, no corrective dispatch needed)

[Run 38741663534](https://github.com/Andersseen/Strata/actions/runs/38741663534), `workflow_dispatch` on
`test/cloudflare-controller-concurrency`, commit `f29cc35db000ea8436b34bd36a67ac25f914925f`.

| Field                                | Value                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pages project                        | `strata-fullstack-qualification` (existing; not created by this run)                                                                                                                     |
| Deployment hash / ID                 | `0a77889b` / `0a77889b-aec0-42d4-83c3-087ab94fe431`                                                                                                                                      |
| Public URL                           | `https://0a77889b.strata-fullstack-qualification.pages.dev`                                                                                                                              |
| Build digest (sha256)                | `39c2ba375ccfa1d7bb4dd260102388832f9399f651066f3ac202cc9fbbf4e020`                                                                                                                       |
| `@strata-sc/core` 0.2.2              | tarball sha256 `a0238aa624a8bc81c688f4be93ab9ef30690446070971792c5cde6bb028e0ad0`                                                                                                        |
| `@strata-sc/analog` 0.2.2            | tarball sha256 `d532688d0cc454487ddeb4437593450840069668e65a0a37d0497fa9e37a054b`                                                                                                        |
| `@strata-sc/server-components` 0.2.1 | tarball sha256 `10e04d8d6184a03c3df68a1d76aa33fbed8b3c647c2105f1b87c3b78da54f533`                                                                                                        |
| Readiness                            | page ready after 5 attempts (9.2 s), no not-ready observation                                                                                                                            |
| Verdicts                             | controller integration, Server Component SSR, interactive island (hydration, navigation, Back/Forward), confidentiality, bounded concurrency: **all GO**; real public deployment: **GO** |
| Original 25-request controller round | `200×17, 404×8`, 0 anomalies                                                                                                                                                             |
| New matrix on the public URL         | 829 requests, 0 anomalous, correlation route present, 0 samples                                                                                                                          |

The tarball digests equal those of failed run 2 because no package source changed. The package files in
this candidate are identical; only the fixture and the diagnostics differ.

## Interpretation

- The historical anomaly was **not reproduced** in 2,000+ further requests across Node, workerd and two
  public deployments, including the exact original 25-request pattern. The new public run passed.
- That does not make the historical failure "transient" or "resolved". The only evidence about a cause is
  circumstantial (intermittent Cloudflare HTML 404s observed during readiness on the same deployment).
  **Root cause: UNCONFIRMED.** Residual risk: if the anomaly was a cross-request defect that depends on a
  particular edge isolate, it could recur; the gate will now capture and classify it.
- A single green run qualifies this candidate and environment only.

## Residual uncertainties

- Public-edge behavior shortly after a deployment is not controllable from the repository; the first
  minutes after creating a Pages deployment showed intermittent edge 404s in the recorded run 2.
- The bounded matrix (a few hundred requests) cannot rule out rare events.
- No production authentication, tenant-aware caching, bindings or real application are covered.

## What this does not change

No package was published, no dist-tag moved, no Changeset or version changed. Only the isolated
`strata-fullstack-qualification` Pages project was deployed to. `strata-www`, `strata-sc-qualification`,
DNS, routes, bindings and databases were not touched.
