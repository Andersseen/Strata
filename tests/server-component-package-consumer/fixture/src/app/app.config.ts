import { provideFileRouter } from "@analogjs/router";
import { ErrorHandler } from "@angular/core";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { provideSkewRecovery, provideStrataHydrationObserver } from "@strata-sc/server-components";
import type { StrataBoundaryError, StrataHydrationObservation } from "@strata-sc/server-components";

// Qualification hook only: `?recovery=reload` opts a document in to the documented
// bounded reload (README "Deployment compatibility"); without it a build mismatch is
// only reported. The server render never sees a location, so it is never opted in.
const reload =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("recovery") === "reload";
const observerMode =
  typeof location !== "undefined" ? new URLSearchParams(location.search).get("observer") : null;

interface MismatchRecord {
  readonly browserBuildId: string;
  readonly serverBuildId: string;
}

interface ErrorRecord {
  readonly name: string;
  readonly category: string | null;
  readonly recovery: string | null;
  readonly message: string;
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

export const appConfig: ApplicationConfig = {
  providers: [
    provideFileRouter(),
    provideClientHydration(),
    { provide: ErrorHandler, useClass: RecordingErrorHandler },
    provideSkewRecovery({
      reload,
      onMismatch: (mismatch: MismatchRecord) => {
        // Observable by the qualification; a real application would log or show a banner.
        const bag = globalThis as { __strataMismatches?: MismatchRecord[] };

        (bag.__strataMismatches ??= []).push(mismatch);
      },
    }),
    provideStrataHydrationObserver((observation: StrataHydrationObservation) => {
      const bag = globalThis as {
        __STRATA_HYDRATION_OBSERVATIONS__?: StrataHydrationObservation[];
      };

      (bag.__STRATA_HYDRATION_OBSERVATIONS__ ??= []).push(observation);
      if (observerMode === "throw") throw new Error("STRATA_OBSERVER_PRIVATE_CANARY");
      if (observerMode === "reject")
        return Promise.reject(new Error("STRATA_OBSERVER_PRIVATE_CANARY"));
    }),
  ],
};
