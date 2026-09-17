# H3 consumer type compatibility review

Reviewed 2026-09-17 against Strata `f258fc3`. This is Astra research and review, not execution of
SPEC-002. The original [SPEC-001 report](consumer-compilation.md) remains historical evidence.
No production code, dependency manifest, lockfile or fixture was changed in this audit.

## Published versions and changes after the experiment

Direct read-only npm registry queries succeeded in this review (unlike the earlier roadmap audit):

| Package    | Registry observation                                                                | Consequence                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| H3         | `latest = 2.0.1-rc.32`, published 2026-09-14; `1x = 1.15.11`; `beta = 2.0.0-beta.5` | No newer published v2 fix was found. A `latest` tag does not make an RC stable.                                                                  |
| crossws    | `latest = 0.4.12`, published 2026-08-20                                             | H3 rc.32's optional peer range is `^0.4.12`; simply installing its current release does not close the platform type graph.                       |
| TypeScript | `latest = 7.0.2`; repository/consumer remain 6.0.3                                  | “Current TypeScript” and Strata's tested compiler are different. A major upgrade is not a declaration fix or an authorized compatibility change. |

Sources: [H3 registry metadata](https://registry.npmjs.org/h3),
[crossws registry metadata](https://registry.npmjs.org/crossws),
[TypeScript registry metadata](https://registry.npmjs.org/typescript).
These are dated observations, not instructions to install mutable tags.

The GitHub API comparison of rc.32 with `main` found exactly one later commit,
[`a8a803b`](https://github.com/h3js/h3/commit/a8a803beb98613677317a2bc5fe0a3017fd98db8):
request-query documentation/JSDoc, with no declaration-compatibility repair. The
[comparison endpoint](https://api.github.com/repos/h3js/h3/compare/v2.0.1-rc.32...main) and
[release feed](https://github.com/h3js/h3/releases/tag/v2.0.1-rc.32) agree on the latest released v2
candidate. Cached raw `main` pages returned older source snapshots; the live API and published
artifacts take precedence for this review. No unreleased `main` fix is claimed.

## Exact causes and ownership

### H3 declaration versus TypeScript lib contract

The installed rc.32 `dist/h3.d.mts` declares `HTTPError.isError` as `static override`.
With TS 6.0.3 and the SPEC-001 libs (`ES2023`, `DOM`, `DOM.Iterable`, `esnext.decorators`),
`ErrorConstructor` has no matching static method, producing TS4113. The shipped
`typescript/lib/lib.esnext.error.d.ts` supplies that member.

The origin is upstream [H3 PR #1297](https://github.com/h3js/h3/pull/1297), merged 2026-02-25 as
[`6f71db2`](https://github.com/h3js/h3/commit/6f71db2d1bbef68df5151be3bffb2ed84a3bf2d3):
H3 adopted ESNext libs and added overrides. The rc.32
[`e6b726b` change](https://github.com/h3js/h3/commit/e6b726bb35523693167d6c0deea059c8d14a4851)
changes the runtime error guard; it does not remove the consumer lib assumption.

This is an upstream declaration/consumer lib mismatch, not a Strata decorator defect or proof
that TS 6 is broken. An explicit, narrow `esnext.error` compatibility requirement is a legitimate
hypothesis for a revised consumer contract. It must not be silently inserted into the fixed
SPEC-001 experiment or confused with disabling declaration checks.

Read-only rechecks against the retained isolated consumer on Node 22.23.0:

| Consumer-local command                                                    | Exit | Diagnostics                         |
| ------------------------------------------------------------------------- | ---- | ----------------------------------- |
| `tsc -p tsconfig.json --noEmit --skipLibCheck false`                      | 2    | TS4113 in H3 and TS2307 for crossws |
| Same, plus `--lib ES2023,DOM,DOM.Iterable,esnext.decorators,esnext.error` | 2    | TS2307 for crossws only             |

TypeScript 6 respects the explicit lib list; installing a newer compiler does not resolve a
missing package. `lib` describes ambient APIs and does not add implementations. On this Node
22.23.0 host, `typeof Error.isError` is `"undefined"`. H3's own static implementation does not
require calling the native static method. Any temporary lib requirement must state that it does
not authorize consumer calls to a nonexistent runtime API. Sources:
[TypeScript lib](https://www.typescriptlang.org/tsconfig/lib.html),
[TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).

### Optional peer types are not optional to the root declaration graph

Published H3 rc.32 uses conditional root entries; the Node entry re-exports the shared index.
That index imports `Hooks`, `Peer` and `Message` from `crossws`, even when a consumer imports only
`H3`. Its manifest lists crossws as an **optional peer**, so a valid HTTP-only install can omit it
and still fail strict declaration checking with TS2307.

Published crossws 0.4.12 was inspected directly from its npm tarball. Its root declaration loads
`_chunks/_types.d.mts`, whose adapter options reference Bun, Cloudflare and other adapters:

- `_chunks/bun.d.mts` imports types from `bun`.
- `_chunks/cloudflare.d.mts` imports `DurableObject` from `cloudflare:workers` and types from
  `@cloudflare/workers-types`.
- crossws's manifest has only optional `srvx` as a peer; its own Bun/Workers development types
  are not installed for consumers. H3's installed srvx 1.0.5 already satisfies that peer.

Source artifacts: [H3 rc.32 metadata](https://registry.npmjs.org/h3/2.0.1-rc.32),
[crossws 0.4.12 metadata](https://registry.npmjs.org/crossws/0.4.12).
The original report's diagnostic-only crossws probe found these missing platform providers;
this audit independently confirmed the import graph, not a clean augmented consumer run.

As of review, registry provider candidates are `@types/bun@1.4.2` (depends on `bun-types@1.4.2`)
and `@cloudflare/workers-types@5.20260917.1`. The latter's `index.d.ts` declares Worker globals and
`cloudflare:workers`; its exported `index.ts` is a different surface. Merely installing the
package does not establish that the ambient module is included by `types: ["node"]`, nor that
loading its globals alongside DOM and Node declarations is safe. Sources:
[Bun type metadata](https://registry.npmjs.org/@types%2fbun/1.4.2),
[Workers type metadata](https://registry.npmjs.org/@cloudflare%2fworkers-types/5.20260917.1).
SPEC-002 must measure this rather than accumulating runtime types until errors disappear.

Issue search found related [H3 #1258](https://github.com/h3js/h3/issues/1258) and
[PR #1435](https://github.com/h3js/h3/pull/1435), concerning the WebSocket response property;
they do not resolve an HTTP-only consumer's missing optional-peer declarations. Queries for
`crossws declarations` in H3 and `types bun` in crossws found no verified released repair for this
exact graph. This is a bounded search result, not proof that no issue exists. No upstream message
or issue was posted.

## Alternatives and disposition

| Hypothesis                                                             | Review disposition                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade to a fixed H3 v2 release                                       | Preferred when a published artifact actually repairs the graph; no newer release or post-rc.32 code fix exists in the retrieved state. No invented rc.33 pin.                                                              |
| Add only `esnext.error`                                                | Removes TS4113, measured. Necessary candidate lib requirement for unchanged rc.32; insufficient for AC2. Ambient API availability must be documented.                                                                      |
| Change TS version, `target`, module resolution or all libs to ESNext   | Not justified. TS 6 already provides the narrow lib; none of these supplies absent crossws types. Keep TS 6.0.3/NodeNext/ES2023 for isolation.                                                                             |
| Declare crossws and all required type providers explicitly             | Unproven bounded hypothesis for SPEC-002. Measure closure, duplicate Node types and global conflicts. A typecheck that needs unrelated runtime globals is not automatically a good Node contract.                          |
| Make crossws a Strata dependency/peer immediately                      | Premature: installing crossws alone exposes further errors. A peer changes who installs a package, not its declarations. A consumer devDependency workaround also does not fix the packed framework's transitive contract. |
| Narrow H3 pin                                                          | Reproducibility control, not a repair. Retain rc.32 for the experiment. No downgrade to an older RC with unrelated fixes missing.                                                                                          |
| Upstream declaration repair                                            | Correct fallback if the published closure is not viable. Produce a minimal H3-only reproduction and exact declaration/import requirements first; no Strata fork or generated declaration surgery chosen.                   |
| Temporary documented constraint                                        | Honest: rc.32 runtime path works, strict type support remains blocked. A revised narrow lib/dependency recipe may be qualified only after all positive checks pass.                                                        |
| `skipLibCheck`, ambient stubs, casts, excluding reachable declarations | Rejected as M1 solutions: they hide the contract under test. [TypeScript documents the accuracy tradeoff](https://www.typescriptlang.org/tsconfig/skipLibCheck.html).                                                      |
| H3 v1 or two adapters                                                  | Out of scope and does not answer the current declaration question. Major interoperability stays in M2.                                                                                                                     |

Strata owns its consumer experience even where upstream owns the defect. A valid public signature
that exposes an unclosed third-party type graph cannot yet be advertised as strict-consumer support.
A Node GET consumer should not have to enable Bun/Workers ambient environments. SPEC-002 permits
those providers only as a diagnostic control, not as an automatically acceptable framework policy.
No permanent dependency/peer policy or new ADR is justified before that result.

## Evidence limitations discovered in the review

1. **Bundler pinning:** the report reads Rolldown 1.2.8 from the workspace lock. The retained consumer's
   `package-lock.json` and installed package both show 1.2.9. The measured runtime outcomes stand,
   but the intended exact 1.2.8 consumer tuple was not enforced. Rerun with actual resolved pins.
2. **Remote CI:** [PR #4](https://github.com/Andersseen/Strata/pull/4) merged 2026-09-17T13:06:39Z.
   The [merge job](https://github.com/Andersseen/Strata/actions/runs/35225050803/job/105214360278)
   failed during lint with 23 unresolved-type errors in adapter source/tests. Typecheck, tests,
   build and consumer qualification were skipped. Core exports `dist` and CI lints before building;
   missing build prerequisites explain the observed errors, while local lint with artifacts passes.
   This is distinct from the measured local AC2 failure. Verify the bootstrap explanation in a
   fresh checkout during SPEC-002; do not suppress lint or claim remote consumer execution.
3. **Report classification:** the runner hard-codes known H3 blame for any nonzero tsc result,
   prints an expected H3 version without asserting it, and marks AC7/AC8 from configuration.
   Those labels cannot replace version assertions, actual diagnostics and reviewer/CI evidence.
4. **Scope:** no fresh full qualification was run in this documentation review. Only the original
   report, retained artifacts, source, remote logs and the two read-only tsc probes were reviewed.
   The original report's machine-local paths remain historical; new evidence must normalize paths.

M1 is Blocked with substantial positive runtime evidence. The single next spec is
[SPEC-002: H3 consumer type closure](../specs/002-h3-consumer-type-closure.md), a bounded
compatibility qualification, with an explicit upstream-blocked outcome if the hypothesis fails.
