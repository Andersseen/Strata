# Strata architecture and SDD

Strata is a structured server application layer for Angular and Analog, powered by H3.
This directory separates implemented facts, architectural decisions, and unproven hypotheses.
Documentation is in English to follow the existing OSS repository conventions.

## Sources of truth

| Question                                     | Authoritative document                                          |
| -------------------------------------------- | --------------------------------------------------------------- |
| What exists and what was actually checked?   | [Current state](STATE.md), backed by source, lockfile and tests |
| What is Strata for?                          | [Vision](VISION.md)                                             |
| What owns each responsibility and boundary?  | [Architecture](ARCHITECTURE.md)                                 |
| What happens next and what gates progress?   | [Roadmap](ROADMAP.md)                                           |
| What does upstream currently provide?        | [Dated ecosystem research](RESEARCH.md)                         |
| Which combinations may we claim to support?  | [Compatibility](COMPATIBILITY.md)                               |
| What remains uncertain?                      | [Risk register](RISKS.md)                                       |
| What evidence must tests produce?            | [Testing strategy](TESTING.md)                                  |
| How do Astra and implementation agents work? | [SDD workflow](SDD.md)                                          |
| When may we release 1.0?                     | [Release gates](RELEASE-1.0.md)                                 |
| How is the public repository configured?     | [Repository operations](REPOSITORY.md)                          |
| Why was a consequential decision made?       | Accepted records in [adr/](adr/)                                |
| What may the next implementation agent do?   | The single ready spec in [specs/](specs/README.md)              |

Code is authoritative for existing behavior. An accepted ADR is authoritative for a design
decision, not proof of implementation. The roadmap describes intent; a checked gate requires
linked evidence. Research describes upstream claims, not Strata compatibility.

## Current handoff

Reconciled 2026-09-24 at `c671ba4` + SPEC-003 branch. See [STATE](STATE.md#reconciliation-2026-09-24).

- **H3 consumer qualification track:** SPEC-001 and SPEC-002 executed; strict consumer types for
  `@strata/h3` remain upstream-blocked (H3/crossws declarations), so M1 stays Blocked.
  [Review evidence](research/h3-consumer-type-compatibility.md) and
  [measured closure matrix](research/consumer-type-closure.md) remain current.
- **Analog integration track:** `@strata/analog` registers controllers on Nitro's router
  ([baseline](research/analog-integration-baseline.md)), with request input (PR #17), per-request
  controllers (PR #18) and request cleanup (PR #19).
  [SPEC-003](specs/003-analog-request-lifecycle-angular-di.md) reached a
  [CONDITIONAL GO for Angular DI](research/analog-di-feasibility.md) through consumer-owned injectors.
- Next bounded step, pending SPEC-003 acceptance: the first strict Server Component feasibility PoC.
- No Server Components implementation exists. Packages are experimental `0.1.0`; only
  `@strata/core` and `@strata/analog` are published to npm, under the `next` dist-tag (first
  publish pending)
  ([ADR-004](adr/004-experimental-npm-distribution.md)).
- 1.0 requires production Server Components, automated boundary evidence and a real consumer.

## Accepted decisions

- [ADR-001: standard decorators and explicit metadata](adr/001-standard-decorators.md).
- [ADR-002: independent core and an initially H3 v2 adapter](adr/002-core-and-h3-target.md).
- [ADR-003: Server Components are a production release gate](adr/003-server-components-release-gate.md).
- [ADR-004: experimental npm distribution of core and analog under `next`](adr/004-experimental-npm-distribution.md).

DI, consumer compiler strategy, component protocol and navigation protocol have **no accepted ADR**
yet. Their experiments are planned in the roadmap; their APIs are not frozen.
