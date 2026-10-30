import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import {
  CorrelatedController,
  CorrelatedLogController,
  recordCorrelated,
  stage,
} from "../strata/correlated.controller";

// Opt-in request correlation (docs/research/analog-request-correlation-v012.md): Strata generates
// one id per invocation; the application decides where to record it. Nothing reaches the response.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [CorrelatedController], {
    requestCorrelation: true,
    guards: [
      ({ request }) => {
        stage("guard", request);
        return request.url.searchParams.has("deny")
          ? { allow: false, status: 403 }
          : { allow: true };
      },
    ],
    interceptors: [
      async ({ request }, next) => {
        stage("interceptor", request);
        return next();
      },
    ],
    controllerFactory(Controller, { request, onCleanup }) {
      stage("factory", request);
      onCleanup(() => {
        stage("cleanup", request);
      });
      return new Controller();
    },
    onRequestSettled(observation) {
      recordCorrelated({ kind: "observation", observation });
    },
  });

  registerControllers(nitroApp.router, [CorrelatedLogController]);
});
