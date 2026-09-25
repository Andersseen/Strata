import { registerControllers } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { GreetingController, GreetingService } from "../strata/greeting.controller";
import { LifecycleController } from "../strata/lifecycle.controller";
import { UsersController } from "../strata/users.controller";

// Strata only registers structure on top of the router Nitro already owns:
// the native file-system routes under `src/server/routes/**` are untouched.
export default defineNitroPlugin((nitroApp) => {
  // Default lifecycle: a new controller instance per request.
  registerControllers(nitroApp.router, [UsersController, LifecycleController]);

  // Custom factory: still one instance per request, built with a dependency
  // the plugin owns. Plain TypeScript — no DI container, no Angular injector.
  const greetings = new GreetingService();

  registerControllers(nitroApp.router, [GreetingController], {
    controllerFactory: (Controller) =>
      Controller === GreetingController ? new GreetingController(greetings) : new Controller(),
  });
});
