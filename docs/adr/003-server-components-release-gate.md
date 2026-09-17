# ADR-003: Production Server Components gate 1.0

- Status: Accepted — product/architecture requirement, implementation unproven
- Date: 2026-09-17
- Evidence: project direction; [vision](../VISION.md); [upstream rendering research](../RESEARCH.md)

## Context

Controllers and SSR alone do not satisfy Strata's intended 1.0 capability. Angular hydration
controls do not themselves guarantee exclusion of server implementations from browser graphs.

## Decision

Require strict server-only implementation and dependency graphs, explicit interactive Angular
descendants, real Analog/runtime integration, a safe navigation strategy, automated security and
build evidence, Node and Cloudflare validation, and at least one real production consumer before 1.0.
The complete authoritative checklist is [RELEASE-1.0](../RELEASE-1.0.md).

## Consequences and alternatives

Run component/compiler feasibility early, before expanding the HTTP framework broadly. A no-go
result blocks 1.0 and may require upstream work or revising the project plan. Shipping useful 0.x
controller releases remains possible without claiming production Server Components.

Rejected alternatives: calling SSR a Server Component, treating `hydrate never` as graph isolation,
shipping a server parent for CSR navigation, and declaring 1.0 after controllers alone.

This ADR does not select `@ServerComponent` syntax, a component transport, compiler package, DI
bridge, streaming model or document-versus-router navigation. Those require experiments and later ADRs.

## Reopening trigger

Only an explicit change to the product's 1.0 objective can replace this gate. Technical difficulty,
an attractive demo or schedule pressure cannot silently weaken it.
