# Vision

**A structured server application layer for Angular and Analog, powered by H3.**

Strata means layers. Its purpose is to give growing HTTP domains consistent controllers, services,
request boundaries, validation, authorization, errors and testing conventions while retaining the
underlying runtime. An Analog application should not need a separate backend framework merely to
organize server code.

The relationship to H3 is architecture and developer experience over a capable HTTP foundation.
It is analogous in purpose to what Nest adds above Express/Fastify, without copying Nest's APIs,
module system or dependency container.

| Need                                                    | Preferred primitive                   |
| ------------------------------------------------------- | ------------------------------------- |
| Simple HTTP endpoint                                    | Native H3 / Analog API route          |
| Structured HTTP domain                                  | Strata controller and domain services |
| Internal Angular RPC                                    | Analog server functions               |
| Server-rendered UI with server-exclusive implementation | Strata Server Components, once proven |

Strata complements Angular's compiler, DI and hydration, Analog's routing/SSR/server functions,
H3's HTTP behavior and Nitro's deployment machinery. It does not own a second router or reproduce
server-function transports, resource state or a Suspense system.

## What 1.0 means

1.0 means a real Angular/Analog application can use Strata Server Components in production with
automated evidence that server implementations and dependencies cannot enter browser output, while
explicit Angular client descendants remain interactive. Controllers alone, an SSR demo or Analog
integration alone cannot satisfy this definition. [Release gates](RELEASE-1.0.md) own the checklist.

ForgeCMS is the preferred real consumer, subject to suitability when the integration is mature.
Strata must have no dependency on ForgeCMS, its schema, routing conventions or product APIs.
Controlled fixtures precede consumer adoption. Another real application is acceptable with a
documented rationale and the same proof obligations.

## Constraints

- Web standards first; Node and Cloudflare runtime evidence are required.
- Standard Strata decorators, explicit metadata, no legacy parameter decorators or reflection DI.
- Explore Angular `inject()` through demonstrated injection contexts; no parallel DI container
  without a separate evidence-backed decision.
- Keep runtime-independent contracts separate from H3, Angular and build-time adapters.
- Create packages only when a concrete responsibility and a tested public boundary require them.
- Treat browser graph exclusion as a security property, not a tree-shaking optimization.
- A failed feasibility experiment can block 1.0. It cannot silently weaken its definition.

Nest Modules, class-validator coupling, mandatory RxJS pipelines, CQRS, microservices, GraphQL,
queues, WebSockets and ORM abstractions are outside this roadmap. Angular's own transitive
dependencies do not imply Strata must expose their programming model.
