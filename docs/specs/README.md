# Implementation specs

Only the next actionable slice receives a detailed spec. Milestone-level intent lives in
[ROADMAP](../ROADMAP.md); workflow and authority live in [SDD](../SDD.md).

| Spec                                                                                 | Status                 | Baseline  | Milestone |
| ------------------------------------------------------------------------------------ | ---------------------- | --------- | --------- |
| [SPEC-001: packed consumer compilation baseline](001-packed-consumer-compilation.md) | Ready; not implemented | `9d2635e` | M1        |

Use sequential IDs and descriptive filenames. A spec is authoritative for that slice's intended
behavior, not for the framework's entire future. Keep no more than one Ready/In progress spec.

## Required template

Each spec starts with ID, title, status, baseline, milestone, owner roles, dependencies and related
ADRs/risks, followed by these sections:

1. **Context** — current source and evidence; distinguish implemented behavior from assumptions.
2. **Problem** — one bounded missing capability or hypothesis.
3. **Goals** — observable outcomes.
4. **Non-goals** — adjacent work deliberately excluded.
5. **Public API impact** — exact new/changed signatures or an explicit statement of no impact.
6. **Architecture** — ownership, data flow, allowed file areas and fixed implementation boundaries.
7. **Constraints** — dependencies, runtime/compiler rules and forbidden shortcuts.
8. **Acceptance criteria** — numbered, verifiable outcomes with failure behavior.
9. **Required tests** — map test cases and commands to acceptance IDs; include negative controls.
10. **Compatibility concerns** — exact starting tuple, affected peers and unproven targets.
11. **Risks** — relevant register IDs and what this slice can/cannot resolve.
12. **Definition of Done** — code/test/review evidence and documentation updates.
13. **Explicitly out of scope** — a final implementation guardrail.

Add alternatives and decision rules for a spike. Specify its reproducible experiment and what a
no-go report must contain. Do not ask a small implementation agent to invent the architecture.
When accepted, append result/PR/evidence links and deviations; preserve the original intent. Keep
unrun checks visible and do not label a completed investigation as a proven production capability.
