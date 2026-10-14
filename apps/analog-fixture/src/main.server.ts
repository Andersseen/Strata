import "@angular/platform-server/init";
import { REQUEST_CONTEXT, inject } from "@angular/core";
import { REQUEST as ANALOG_REQUEST } from "@analogjs/router/tokens";
import { render } from "@analogjs/router/server";

import { App } from "./app/app";
import { config } from "./app/app.config.server";

export default render(App, config, [
  {
    provide: REQUEST_CONTEXT,
    useFactory: () => {
      const request = inject(ANALOG_REQUEST);
      const parsed = new URL(request.originalUrl ?? request.url, "http://localhost");

      if (!parsed.pathname.startsWith("/server-component-request-context/")) return null;
      if (parsed.searchParams.has("missing")) return null;

      const id = parsed.pathname.split("/").filter(Boolean).at(-1);

      return {
        id: id === "beta" ? "beta" : "alpha",
        round: parsed.searchParams.get("round") ?? "default",
        confidential: "request-context-confidential-alpha-beta",
      };
    },
  },
]);
