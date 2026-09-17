# ADR-001: Standard decorators with explicit metadata

- Status: Accepted — records the existing implementation and project constraint
- Date: 2026-09-17
- Evidence: `80341ea`; `packages/core/src/metadata/`; [current state](../STATE.md)

## Context

Core already uses standard decorator contexts and `Symbol.metadata`. It does not infer constructor
types or use legacy reflection. Its private build transform demonstrates that syntax support and
executable output are separate concerns.

## Decision

Keep Strata decorators on the standard model with explicit metadata behind the public
`getControllerDefinition` boundary. No `experimentalDecorators`, `emitDecoratorMetadata`,
`reflect-metadata` or legacy parameter decorators for Strata. Preserve guarded symbol initialization
until the supported runtime matrix makes it unnecessary.

## Consequences and alternatives

Request inputs require an explicit modern API comparison; Angular DI must not depend on reflected
constructor parameter types. Consumer compilation and Angular AOT coexistence require independent
proof. This ADR does not choose a public transform/plugin or claim every JS engine implements the
metadata proposal natively.

Legacy Nest-style decorator/parameter APIs were rejected because they contradict the chosen
semantics. A functional authoring API remains possible where justified, without reversing this ADR.

## Reopening trigger

An upstream standards/compiler change or a demonstrated blocking interoperability issue requires a
new decision. An implementation agent cannot silently enable legacy mode to pass tests.
