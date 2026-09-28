import { provideFileRouter } from "@analogjs/router";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";

import { provideIslandProbe, provideNavigationProbe } from "../server-components/probe";

export const appConfig: ApplicationConfig = {
  providers: [
    provideFileRouter(),
    provideClientHydration(),
    provideNavigationProbe(),
    provideIslandProbe(),
  ],
};
