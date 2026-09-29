import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { IncidentsController } from "../strata/incidents.controller";
import { OperationsController } from "../strata/operations.controller";
import { operationsRepository } from "../strata/operations.repository";
import { RequestAudit } from "../strata/request-audit";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [OperationsController, IncidentsController], {
    controllerFactory: (Controller, { request, onCleanup }) => {
      const audit = new RequestAudit(request.headers.get("x-relay-request") ?? undefined);
      onCleanup(() => audit.complete());

      if (Controller === OperationsController) {
        return new OperationsController(operationsRepository, audit);
      }

      if (Controller === IncidentsController) {
        return new IncidentsController(operationsRepository, audit);
      }

      return new Controller();
    },
  });
});
