export { ServerComponent } from "./server-component.js";
export { StrataClientBoundary } from "./client-boundary.js";
export type {
  ClientBoundaryPrimitive,
  ClientBoundaryObject,
  ClientBoundaryProps,
  ClientBoundaryValue,
} from "./client-boundary.js";
export type { ClientReferenceDescriptor, ClientReferenceInput } from "./client-references.js";
export { StrataIslandHost, provideClientReferences } from "./islands.js";
export { StrataBoundaryError, StrataBuildMismatchError } from "./boundary-protocol.js";
export {
  MAX_CLIENT_BOUNDARIES_PER_HOST,
  MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST,
} from "./boundary-protocol.js";
export type { BoundaryFailureCategory, BuildRecoveryOutcome } from "./boundary-protocol.js";
export { provideSkewRecovery } from "./skew-recovery.js";
export type { BuildMismatch, SkewRecoveryOptions } from "./skew-recovery.js";
export { provideStrataHydrationObserver } from "./hydration-observer.js";
export type {
  StrataHydrationObservation,
  StrataHydrationObserver,
  StrataHydrationOutcome,
} from "./hydration-observer.js";
