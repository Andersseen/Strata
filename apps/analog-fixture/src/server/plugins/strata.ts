import { registerControllers } from "@strata/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { UsersController } from "../strata/users.controller";

// Strata only registers structure on top of the router Nitro already owns:
// the native file-system routes under `src/server/routes/**` are untouched.
export default defineNitroPlugin((nitroApp) => {
  registerControllers(nitroApp.router, [UsersController]);
});
