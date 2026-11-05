import { inject, mergeApplicationConfig, provideAppInitializer } from "@angular/core";
import type { ApplicationConfig } from "@angular/core";
import { REQUEST, RESPONSE } from "@analogjs/router/tokens";
import { provideServerRendering } from "@angular/platform-server";
import { provideStrataSsrFailureHandler } from "@strata-sc/server-components/ssr";

import { appConfig } from "./app.config";

const failureMode = (): string => {
  const request = inject(REQUEST, { optional: true });
  return request?.originalUrl ?? request?.url ?? "";
};

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(),
    // Opt-in SSR failure contract (the render wrapper is in main.server.ts).
    provideStrataSsrFailureHandler(RESPONSE),
    // Deterministic "error before rendering starts" for the SSR failure contract only.
    provideAppInitializer(() => {
      if (failureMode().startsWith("/render-failure/bootstrap"))
        throw new Error("bootstrap failure RENDER_FAILURE_PRIVATE_5c1e");
    }),
    // Deterministic asynchronous rejection with a NON-Error reason: a naive logger would print it.
    provideAppInitializer(() => {
      if (failureMode().startsWith("/render-failure/rejection"))
        return Promise.reject("rejected initializer RENDER_FAILURE_PRIVATE_5c1e");
      return undefined;
    }),
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
