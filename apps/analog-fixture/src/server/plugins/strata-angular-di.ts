import { Injector } from "@angular/core";
import { registerControllers } from "@strata/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { createAngularControllerFactory } from "../strata/angular-di/angular-controller-factory";
import { AngularDiController } from "../strata/angular-di/angular-di.controller";
import { AppGreetingService } from "../strata/angular-di/providers";

// Experiment: Angular DI through `controllerFactory`, owned by the consumer.
// A Nitro plugin has no access to the Angular application's injector (Analog
// creates one per SSR render), so this app-level injector is created here,
// explicitly, and is not shared with SSR. Request injectors are released by
// the factory's `onCleanup`; only the app-level injector follows Nitro's
// application lifecycle.
export default defineNitroPlugin((nitroApp) => {
  const appInjector = Injector.create({
    name: "strata-analog-fixture",
    providers: [{ provide: AppGreetingService, useFactory: () => new AppGreetingService() }],
  });

  nitroApp.hooks.hook("close", () => {
    appInjector.destroy();
  });

  registerControllers(nitroApp.router, [AngularDiController], {
    controllerFactory: createAngularControllerFactory(appInjector),
  });
});
