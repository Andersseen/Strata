import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import {
  FIXTURE_PUBLIC_ORIGIN,
  PublicUrlController,
  TransportUrlController,
  sameOriginGuard,
} from "../strata/request-url.controller";

export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [TransportUrlController]);
  registerControllers(nitroApp.router, [PublicUrlController], {
    publicOrigin: FIXTURE_PUBLIC_ORIGIN,
    guards: [sameOriginGuard],
  });
});
