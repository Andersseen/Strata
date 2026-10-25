import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { HeadersController } from "../strata/headers.controller";
import { FormsController } from "../strata/forms.controller";
import {
  ObservedController,
  ObservedLogController,
  record,
  toLogLine,
} from "../strata/observed.controller";

// Consumer-owned observability (docs/research/analog-request-observability-v08.md):
// Strata hands over safe facts, the application decides to log, count or export them.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [ObservedController, HeadersController, FormsController], {
    controllerFactory(Controller, { request, onCleanup }) {
      onCleanup(() => {
        record({ kind: "cleanup", resource: request.path });
        if (request.path === "/api/strata/forms/cleanup-fail") {
          throw new Error("fixture-private-form-cleanup-canary");
        }
      });
      return new Controller();
    },
    onRequestSettled(observation) {
      record({ kind: "observation", observation });
      console.log(toLogLine(observation));
    },
  });

  registerControllers(nitroApp.router, [ObservedLogController]);
});
