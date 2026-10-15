import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { lifecycleStats } from "../strata/lifecycle-stats";
import { ProductsController } from "../strata/products.controller";

// The documented Nitro integration: Strata only adds routes to the router Nitro
// already owns. The controller factory is plain TypeScript; there is no Angular
// injector here and none is shared with SSR.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [ProductsController], {
    controllerFactory: (Controller, { onCleanup }) => {
      lifecycleStats.created++;
      onCleanup(() => {
        lifecycleStats.cleaned++;
      });

      return new Controller();
    },
  });
});
