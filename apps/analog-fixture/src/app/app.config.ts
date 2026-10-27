import { provideFileRouter } from "@analogjs/router";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";

import {
  provideErrorProbe,
  provideHydrationObservationProbe,
  provideIslandProbe,
  provideNavigationProbe,
} from "../probes/server-components/probe";

export const appConfig: ApplicationConfig = {
  providers: [
    provideFileRouter(),
    provideClientHydration(),
    provideNavigationProbe(),
    provideIslandProbe(),
    provideErrorProbe(),
    provideHydrationObservationProbe(),
  ],
};
