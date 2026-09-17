# ADR-002: Independent core; initially an H3 v2 adapter

- Status: Accepted — existing package boundary and experimental target, not production support
- Date: 2026-09-17
- Evidence: `b899c59`, manifests, lockfile and adapter tests; [research](../RESEARCH.md)

## Context

The repository already separates runtime-independent metadata from registration on a caller-owned
`H3` instance. Its manifest requests `^2.0.1-rc.1`; the lockfile resolves `2.0.1-rc.32`. Analog's
researched Nitro 2 dependency lineage uses H3 v1, so integration is not automatic.

## Decision

Retain the locked H3 v2 RC as the initial standalone experimental baseline. Keep H3 routing, event,
response/error and version-bridge concerns inside `@strata/h3`; core must not import H3 or become
its wrapper. Preserve native H3 ownership and routes. Make no H3 v1 or Analog support claim yet.

## Consequences and alternatives

Qualification uses exact versions, not the entire manifest range. M2 must prove a viable Analog
runtime path before stable integration. Simultaneous v1/v2 support is deferred until real demand
and separate tested adapter paths justify maintenance. A dedicated v1 path, a Web API bridge and a
supported upstream upgrade remain experimental alternatives; none is selected here.

Starting over on H3 v1 now would discard working evidence without proving Analog integration.
Pretending both majors share one app/event contract would hide incompatible behavior. Keeping
v2 experimentally does not commit Strata 1.0 to an unqualified prerelease.

## Reopening trigger

M2 results, a maintained upstream release, an incompatible required Analog runtime or an advisory
that invalidates the baseline. [Compatibility policy](../COMPATIBILITY.md) governs promotion.
