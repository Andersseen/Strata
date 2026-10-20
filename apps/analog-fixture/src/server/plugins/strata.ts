import { registerControllers } from "@strata-sc/analog";
import type { StrataAnalogInterceptor } from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { GreetingController, GreetingService } from "../strata/greeting.controller";
import { LifecycleController } from "../strata/lifecycle.controller";
import { MethodsController } from "../strata/methods.controller";
import { InventoryController, inventoryGuard } from "../strata/inventory.controller";
import { UsersController } from "../strata/users.controller";
import { ValidationController } from "../strata/validation.controller";
import {
  ProtectedProductsController,
  protectedProductsGuard,
} from "../strata/protected-products.controller";

// Strata only registers structure on top of the router Nitro already owns:
// the native file-system routes under `src/server/routes/**` are untouched.
const passThroughInterceptor: StrataAnalogInterceptor = async (_context, next) => next();

export default defineNitroPlugin((nitroApp) => {
  // Default lifecycle: a new controller instance per request.
  registerControllers(
    nitroApp.router,
    [UsersController, LifecycleController, MethodsController, ValidationController],
    { interceptors: [passThroughInterceptor] },
  );

  registerControllers(nitroApp.router, [ProtectedProductsController], {
    guards: [protectedProductsGuard],
    interceptors: [passThroughInterceptor],
  });

  registerControllers(nitroApp.router, [InventoryController], {
    guards: [inventoryGuard],
    interceptors: [passThroughInterceptor],
  });

  // Custom factory: still one instance per request, built with a dependency
  // the plugin owns. Plain TypeScript — no DI container, no Angular injector.
  const greetings = new GreetingService();
  const timingInterceptor: StrataAnalogInterceptor = async (context, next) => {
    const started = performance.now();
    try {
      return await next();
    } finally {
      // The fixture observes that the stable route context is available here.
      void context.route.path;
      void (performance.now() - started);
    }
  };
  const resultInterceptor: StrataAnalogInterceptor = async (_context, next) => {
    const result: unknown = await next();
    if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
    return { ...result, intercepted: true };
  };

  registerControllers(nitroApp.router, [GreetingController], {
    controllerFactory: (Controller) =>
      Controller === GreetingController ? new GreetingController(greetings) : new Controller(),
    interceptors: [timingInterceptor, resultInterceptor],
  });
});
