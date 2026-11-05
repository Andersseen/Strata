import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { ProductsController } from "../strata/products.controller";
import { ScaleR1Controller } from "../strata/scale/r1.controller";
import { ScaleR2Controller } from "../strata/scale/r2.controller";
import { ScaleR3Controller } from "../strata/scale/r3.controller";
import { ScaleR4Controller } from "../strata/scale/r4.controller";
import { ScaleR5Controller } from "../strata/scale/r5.controller";
import { ScaleR6Controller } from "../strata/scale/r6.controller";
import { ScaleR7Controller } from "../strata/scale/r7.controller";
import { ScaleR8Controller } from "../strata/scale/r8.controller";
import { scaleFactory, scaleGuard } from "../strata/scale/ledger";

// The documented Nitro integration, with the scaling profile's eight extra controllers, one
// authorization guard and a request-scoped factory. Strata only adds routes to Nitro's router.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(
    nitroApp.router,
    [
      ProductsController,
      ScaleR1Controller,
      ScaleR2Controller,
      ScaleR3Controller,
      ScaleR4Controller,
      ScaleR5Controller,
      ScaleR6Controller,
      ScaleR7Controller,
      ScaleR8Controller,
    ],
    { guards: [scaleGuard], controllerFactory: scaleFactory },
  );
});
