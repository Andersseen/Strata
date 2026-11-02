import { ErrorHandler } from "@angular/core";
import type { Provider } from "@angular/core";
import { provideSkewRecovery, provideStrataHydrationObserver } from "@strata-sc/server-components";
import type { StrataBoundaryError, StrataHydrationObservation } from "@strata-sc/server-components";

/**
 * Upgrade/rollback qualification probes (tools/server-components/registry-upgrade-rollback.ts).
 * Only compiled in when the build sets VITE_STRATA_UPGRADE_PROBES=1, and browser-only: the server
 * render never holds a location, so it is never opted in to recovery and keeps no per-request record.
 *
 * `?recovery=reload` opts a document in to the documented bounded reload; without it a build
 * mismatch is only reported.
 */

interface ErrorRecord {
  readonly name: string;
  readonly category: string | null;
  readonly recovery: string | null;
  readonly message: string;
}

interface MismatchRecord {
  readonly browserBuildId: string;
  readonly serverBuildId: string;
}

/** Reports like Angular's default handler and keeps a record the qualification can read. */
class RecordingErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    const strata = error as Partial<StrataBoundaryError & { recovery: string }>;
    const bag = globalThis as { __strataErrors?: ErrorRecord[] };

    (bag.__strataErrors ??= []).push({
      name: strata.name ?? "Error",
      category: strata.category ?? null,
      recovery: strata.recovery ?? null,
      message: String(strata.message ?? error),
    });
    console.error("ERROR", error);
  }
}

export function upgradeProbeProviders(): Provider[] {
  if (typeof window === "undefined") return [];

  const reload = new URLSearchParams(window.location.search).get("recovery") === "reload";

  return [
    { provide: ErrorHandler, useClass: RecordingErrorHandler },
    provideSkewRecovery({
      reload,
      onMismatch: (mismatch: MismatchRecord) => {
        const bag = globalThis as { __strataMismatches?: MismatchRecord[] };

        (bag.__strataMismatches ??= []).push(mismatch);
      },
    }),
    provideStrataHydrationObserver((observation: StrataHydrationObservation) => {
      const bag = globalThis as {
        __STRATA_HYDRATION_OBSERVATIONS__?: StrataHydrationObservation[];
      };

      (bag.__STRATA_HYDRATION_OBSERVATIONS__ ??= []).push(observation);
    }),
  ];
}
