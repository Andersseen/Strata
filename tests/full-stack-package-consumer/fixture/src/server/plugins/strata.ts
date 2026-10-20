import { registerControllers } from "@strata-sc/analog";
import type { StrataAnalogInterceptor } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { lifecycleStats } from "../strata/lifecycle-stats";
import { ProductsController } from "../strata/products.controller";
import { QualificationController } from "../strata/qualification.controller";
import { HttpContractController } from "../strata/http-contract.controller";
import {
  GuardedProductsController,
  syntheticAuthorizationGuard,
} from "../strata/guarded-products.controller";

const interceptController: StrataAnalogInterceptor = async (_context, next) => next();

// The documented Nitro integration: Strata only adds routes to the router Nitro
// already owns. The controller factory is plain TypeScript; there is no Angular
// injector here and none is shared with SSR.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [ProductsController, QualificationController], {
    controllerFactory: (Controller, { onCleanup }) => {
      lifecycleStats.created++;
      onCleanup(() => {
        lifecycleStats.cleaned++;
      });

      return new Controller();
    },
    interceptors: [interceptController],
  });
  registerControllers(nitroApp.router, [GuardedProductsController], {
    guards: [syntheticAuthorizationGuard],
    interceptors: [interceptController],
  });
  registerControllers(nitroApp.router, [HttpContractController], {
    interceptors: [interceptController],
  });
});
