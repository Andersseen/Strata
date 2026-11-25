import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import {
  PINNED_ORIGIN,
  PinnedOriginController,
  sameOriginGuard,
  TransportOriginController,
} from "../strata/request-origin.controller";

// S-1 (docs/research/rc0-production-requalification.md). `publicOrigin` is the one trusted origin;
// the second registration deliberately has none, so its origin stays transport information.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [PinnedOriginController], {
    publicOrigin: PINNED_ORIGIN,
    guards: [sameOriginGuard],
  });
  registerControllers(nitroApp.router, [TransportOriginController]);
});
