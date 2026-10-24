import { provideFileRouter } from "@analogjs/router";
import { ErrorHandler } from "@angular/core";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { provideSkewRecovery } from "@strata-sc/server-components";
import type { StrataBoundaryError } from "@strata-sc/server-components";

// Qualification hook only: `?recovery=reload` opts a document in to the documented
// bounded reload (README "Deployment compatibility"); without it a build mismatch is
// only reported. The server render never sees a location, so it is never opted in.
const reload =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("recovery") === "reload";

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
  ],
};
