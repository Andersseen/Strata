import { DOCUMENT, Injectable, InjectionToken, inject } from "@angular/core";
import type { Provider } from "@angular/core";

import type { StrataBuildMismatchError } from "./boundary-protocol.js";

/** What a consumer is told about a confirmed deployment skew. Public deployment labels only. */
export interface BuildMismatch {
  /** The application build this browser runtime was compiled from. */
  readonly browserBuildId: string;
  /** The application build that rendered the document. */
  readonly serverBuildId: string;
}

export interface SkewRecoveryOptions {
  /**
   * Reload the document once when a confirmed build mismatch is found. Omitted
   * or `false`: the mismatch is only reported. A reload replaces the whole
   * document, including every healthy island and any unsaved state in it.
   */
  readonly reload?: boolean;
  /** Most reloads per window and tab, 1 to 3. Default 1. */
  readonly maxReloads?: number;
  /** Length of the window in seconds, 30 to 3600. Default 300. */
  readonly windowSeconds?: number;
  /**
   * Called synchronously for every refused host with a confirmed mismatch,
   * before the reload decision. A throw is ignored; the error itself still
   * reaches the application's `ErrorHandler`.
   */
  readonly onMismatch?: (mismatch: BuildMismatch) => void;
}

/** The browser facilities recovery touches, replaceable in tests. */
export interface SkewRecoveryEnvironment {
  /** Per-tab storage, or a throw when the browser blocks it. */
  storage(): Pick<Storage, "getItem" | "setItem">;
  now(): number;
  reload(): void;
}

export const SKEW_RECOVERY_ENVIRONMENT = new InjectionToken<SkewRecoveryEnvironment>(
  "STRATA_SKEW_RECOVERY_ENVIRONMENT",
  {
    providedIn: "root",
    factory: () => {
      const view = inject(DOCUMENT).defaultView;

      return {
        // Reading `sessionStorage` itself throws when the browser blocks it.
        storage: () => view!.sessionStorage,
        now: () => Date.now(),
        reload: () => view!.location.reload(),
      };
    },
  },
);

const SKEW_RECOVERY_OPTIONS = new InjectionToken<SkewRecoveryOptions>("STRATA_SKEW_RECOVERY", {
  providedIn: "root",
  factory: () => ({}),
});

/**
 * Opts in to reporting and, optionally, bounded recovery from a confirmed
 * deployment skew. Without this provider a mismatch is an error in the
 * application's `ErrorHandler` and the server-rendered DOM stays as it is.
 */
export function provideSkewRecovery(options: SkewRecoveryOptions = {}): Provider {
  return { provide: SKEW_RECOVERY_OPTIONS, useValue: options };
}

/** One tab-scoped key holding only counters and a timestamp, never a URL or a build identity. */
export const SKEW_RECOVERY_STORAGE_KEY = "strata:skew-recovery";

const clamp = (value: number | undefined, fallback: number, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;

/**
 * The recovery policy of one application instance: at most one reload is
 * scheduled per instance, and at most `maxReloads` per window and tab, counted
 * in `sessionStorage` before the reload is requested. Anything unreadable,
 * unwritable or implausible in that record means no reload: the page stays in
 * its fail-closed state.
 */
@Injectable({ providedIn: "root" })
export class SkewRecovery {
  private readonly options = inject(SKEW_RECOVERY_OPTIONS);
  private readonly environment = inject(SKEW_RECOVERY_ENVIRONMENT);
  private reloading = false;

  /** Applies the policy and records the outcome on the error. Never throws. */
  handle(error: StrataBuildMismatchError): void {
    try {
      this.options.onMismatch?.({
        browserBuildId: error.browserBuildId,
        serverBuildId: error.serverBuildId,
      });
    } catch {
      // A consumer callback must not stop the policy or hide the boundary error.
    }

    error.recovery = this.decide();
  }

  private decide(): StrataBuildMismatchError["recovery"] {
    if (this.options.reload !== true) return "disabled";
    if (this.reloading) return "reloading";

    const maxReloads = clamp(this.options.maxReloads, 1, 1, 3);
    const windowMs = clamp(this.options.windowSeconds, 300, 30, 3600) * 1000;

    try {
      const storage = this.environment.storage();
      const now = this.environment.now();
      const record = parseRecord(storage.getItem(SKEW_RECOVERY_STORAGE_KEY));

      // An implausible record (not ours, from the future) counts as exhausted.
      if (record === "invalid") return "exhausted";
      const current =
        record && now - record.since < windowMs && now >= record.since ? record : null;

      if (current && current.count >= maxReloads) return "exhausted";

      storage.setItem(
        SKEW_RECOVERY_STORAGE_KEY,
        JSON.stringify({ count: (current?.count ?? 0) + 1, since: current?.since ?? now }),
      );
      // Read back: a storage that accepts writes and forgets them would loop.
      const stored = parseRecord(storage.getItem(SKEW_RECOVERY_STORAGE_KEY));

      if (stored === null || stored === "invalid") return "storage-unavailable";
    } catch {
      return "storage-unavailable";
    }

    this.reloading = true;
    try {
      this.environment.reload();
    } catch {
      return "exhausted";
    }

    return "reloading";
  }
}

interface RecoveryRecord {
  readonly count: number;
  readonly since: number;
}

function parseRecord(text: string | null): RecoveryRecord | null | "invalid" {
  if (text === null) return null;

  try {
    const value = JSON.parse(text) as Partial<Record<keyof RecoveryRecord, unknown>> | null;

    if (
      typeof value === "object" &&
      value !== null &&
      typeof value.count === "number" &&
      typeof value.since === "number" &&
      Number.isSafeInteger(value.count) &&
      Number.isSafeInteger(value.since) &&
      value.count >= 0
    ) {
      return { count: value.count, since: value.since };
    }
  } catch {
    // fall through
  }

  return "invalid";
}
