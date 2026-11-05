import "@angular/platform-server/init";
import { render } from "@analogjs/router/server";
import { REQUEST as ANALOG_REQUEST } from "@analogjs/router/tokens";
import { REQUEST_CONTEXT, inject } from "@angular/core";

import { App } from "./app/app";
import { config } from "./app/app.config.server";
import { withRenderFailureStatus } from "./app/render-failure-status";
import { resolveTenant } from "./server/strata/tenant-authorization";

// The application owns its server entry: an unexpected render failure becomes a generic HTTP 500
// before Analog writes the response (app/render-failure-status.ts).
export default withRenderFailureStatus(
  render(App, config, [
    {
      provide: REQUEST_CONTEXT,
      useFactory: () => {
        const request = inject(ANALOG_REQUEST);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        // The pure credential policy is independently invoked for each SSR request.
        return { headers, principal: resolveTenant(headers) };
      },
    },
  ]),
);
