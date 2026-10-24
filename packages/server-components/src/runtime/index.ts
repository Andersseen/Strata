export { ServerComponent } from "./server-component.js";
export { StrataClientBoundary } from "./client-boundary.js";
export type {
  ClientBoundaryPrimitive,
  ClientBoundaryObject,
  ClientBoundaryProps,
  ClientBoundaryValue,
} from "./client-boundary.js";
export { StrataIslandHost, provideClientReferences } from "./islands.js";
export { StrataBoundaryError, StrataBuildMismatchError } from "./boundary-protocol.js";
export type { BoundaryFailureCategory, BuildRecoveryOutcome } from "./boundary-protocol.js";
export { provideSkewRecovery } from "./skew-recovery.js";
export type { BuildMismatch, SkewRecoveryOptions } from "./skew-recovery.js";
