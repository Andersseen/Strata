import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { ProductsController } from "../strata/products.controller";

// The documented Nitro integration: Strata only adds routes to the router Nitro owns.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [ProductsController]);
});
