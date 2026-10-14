import "@angular/platform-server/init";
import { REQUEST_CONTEXT, inject } from "@angular/core";
import { REQUEST as ANALOG_REQUEST } from "@analogjs/router/tokens";
import { render } from "@analogjs/router/server";

import { App } from "./app/app";
import { config } from "./app/app.config.server";
import { resolveRequestContext } from "./app/server-component-request-context/request-context-resolver";

export default render(App, config, [
  {
    provide: REQUEST_CONTEXT,
    useFactory: () => {
      const request = inject(ANALOG_REQUEST);
      return resolveRequestContext(request.originalUrl ?? request.url);
    },
  },
]);
