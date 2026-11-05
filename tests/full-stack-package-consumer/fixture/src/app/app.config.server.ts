import { inject, mergeApplicationConfig, provideAppInitializer } from "@angular/core";
import type { ApplicationConfig } from "@angular/core";
import { REQUEST } from "@analogjs/router/tokens";
import { provideServerRendering } from "@angular/platform-server";

import { appConfig } from "./app.config";
import { provideRenderFailureStatus } from "./render-failure-status";

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(),
    provideRenderFailureStatus(),
    // Deterministic "error before rendering starts" for the SSR failure contract only.
    provideAppInitializer(() => {
      const request = inject(REQUEST, { optional: true });
      if ((request?.originalUrl ?? request?.url ?? "").startsWith("/render-failure/bootstrap"))
        throw new Error("bootstrap failure RENDER_FAILURE_PRIVATE_5c1e");
    }),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
