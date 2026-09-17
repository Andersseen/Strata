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
| Why was a consequential decision made?       | Accepted records in [adr/](adr/)                                |
| What may the next implementation agent do?   | The single ready spec in [specs/](specs/README.md)              |

Code is authoritative for existing behavior. An accepted ADR is authoritative for a design
decision, not proof of implementation. The roadmap describes intent; a checked gate requires
linked evidence. Research describes upstream claims, not Strata compatibility.

## Current handoff

- Audited baseline: `9d2635e`, 2026-09-17. Both packages remain experimental at `0.0.0`.
- Next: [SPEC-001 — packed consumer compilation baseline](specs/001-packed-consumer-compilation.md).
- No Angular integration or Server Components implementation exists yet.
- 1.0 requires production Server Components, automated boundary evidence and a real consumer.

## Accepted decisions

- [ADR-001: standard decorators and explicit metadata](adr/001-standard-decorators.md).
- [ADR-002: independent core and an initially H3 v2 adapter](adr/002-core-and-h3-target.md).
- [ADR-003: Server Components are a production release gate](adr/003-server-components-release-gate.md).

DI, consumer compiler strategy, component protocol and navigation protocol have **no accepted ADR**
yet. Their experiments are planned in the roadmap; their APIs are not frozen.
