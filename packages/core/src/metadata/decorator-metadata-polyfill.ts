/**
 * The decorator metadata proposal (`context.metadata`) is part of the standard
 * decorators TypeScript already emits for, but the well-known `Symbol.metadata`
 * it relies on isn't defined by every JS engine yet (Node.js included, at the
 * time of writing). TC39's own guidance for consumers of this proposal is to
 * polyfill the symbol with a guarded assignment — this is plain JavaScript,
 * not `reflect-metadata` and not `emitDecoratorMetadata`.
 *
 * Importing this module for its side effect guarantees the symbol exists
 * before any Strata decorator runs.
 */
const globalSymbol = Symbol as unknown as { metadata?: symbol };
globalSymbol.metadata ??= Symbol("Symbol.metadata");
