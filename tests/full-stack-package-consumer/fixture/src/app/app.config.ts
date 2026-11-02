import { provideFileRouter } from "@analogjs/router";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";

import { upgradeProbeProviders } from "./upgrade-probes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideFileRouter(),
    provideClientHydration(),
    // Upgrade/rollback qualification only (VITE_STRATA_UPGRADE_PROBES=1 at build time).
    ...(import.meta.env["VITE_STRATA_UPGRADE_PROBES"] === "1" ? upgradeProbeProviders() : []),
  ],
};
