import { InjectionToken } from "@angular/core";
import type { Provider } from "@angular/core";

import type { BoundaryFailureCategory, BuildRecoveryOutcome } from "./boundary-protocol.js";

/** The terminal result of Strata's transaction for one Server Component host. */
export type StrataHydrationOutcome = "committed" | "preflight-refused" | "commit-failed";

/** One immutable, privacy-safe observation of a host's Strata commit attempt. */
export interface StrataHydrationObservation {
  /** The generated host element's public selector (for example, `strata-product-details`). */
  readonly hostSelector: string;
  readonly outcome: StrataHydrationOutcome;
  readonly discoveredBoundaries: number;
  /** Zero on refusal and commit failure; equals `discoveredBoundaries` on success. */
  readonly committedBoundaries: number;
  /** Present for classified Strata boundary errors; arbitrary component errors are not classified. */
  readonly failureCategory?: BoundaryFailureCategory;
  /** True only when both application build identities confirmed a mismatch. */
  readonly buildMismatch: boolean;
  /** Set only for a confirmed mismatch after the configured recovery policy has run. */
  readonly recoveryOutcome?: BuildRecoveryOutcome;
  /** Monotonic duration of Strata preflight and commit, including rollback on failure, in ms. */
  readonly elapsedMs: number;
}

/** Synchronously receives one terminal observation; returned values are ignored. */
export type StrataHydrationObserver = (observation: StrataHydrationObservation) => void;

export const STRATA_HYDRATION_OBSERVER = new InjectionToken<StrataHydrationObserver>(
  "STRATA_HYDRATION_OBSERVER",
);

/** Opts this application injector into browser-side host commit observations. */
export function provideStrataHydrationObserver(observer: StrataHydrationObserver): Provider {
  return { provide: STRATA_HYDRATION_OBSERVER, useValue: observer };
}

/** @internal Isolates application callback failures from the host transaction. */
export function notifyStrataHydrationObserver(
  observer: StrataHydrationObserver | null,
  event: StrataHydrationObservation,
): void {
  if (!observer) return;
  try {
    const immutable = Object.freeze(
      Object.assign(Object.create(null) as StrataHydrationObservation, event),
    );
    const result = observer(immutable);
    // Resolve through the intrinsic and attach a rejection handler immediately;
    // this also consumes rejected custom thenables without awaiting them.
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      const settled = Promise.resolve(result);
      void Promise.prototype.then.call(settled, undefined, () => undefined);
    }
  } catch {
    // Observation is supplementary and must not affect hydration or error flow.
  }
}
