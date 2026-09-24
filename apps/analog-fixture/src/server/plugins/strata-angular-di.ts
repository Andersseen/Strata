import { Injector } from "@angular/core";
import { registerControllers } from "@strata/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import {
  ANGULAR_DI_SCOPE_KEY,
  createAngularControllerFactory,
  destroyAngularDiScope,
} from "../strata/angular-di/angular-controller-factory";
import type { AngularDiScopeSlot } from "../strata/angular-di/angular-controller-factory";
import { AngularDiController } from "../strata/angular-di/angular-di.controller";
import { AppGreetingService } from "../strata/angular-di/providers";

// Experiment: Angular DI through `controllerFactory`, owned by the consumer.
// A Nitro plugin has no access to the Angular application's injector (Analog
// creates one per SSR render), so this app-level injector is created here,
// explicitly, and is not shared with SSR.
export default defineNitroPlugin((nitroApp) => {
  const appInjector = Injector.create({
    name: "strata-analog-fixture",
    providers: [{ provide: AppGreetingService, useFactory: () => new AppGreetingService() }],
  });

  const slotOf = (context: Record<string, unknown>) =>
    context[ANGULAR_DI_SCOPE_KEY] as AngularDiScopeSlot | undefined;

  nitroApp.hooks.hook("request", (event) => {
    event.context[ANGULAR_DI_SCOPE_KEY] = {} satisfies AngularDiScopeSlot;
  });
  nitroApp.hooks.hook("afterResponse", (event) => {
    destroyAngularDiScope(slotOf(event.context));
  });
  nitroApp.hooks.hook("error", (_error, { event }) => {
    if (event) {
      destroyAngularDiScope(slotOf(event.context));
    }
  });
  nitroApp.hooks.hook("close", () => {
    appInjector.destroy();
  });

  registerControllers(nitroApp.router, [AngularDiController], {
    controllerFactory: createAngularControllerFactory(appInjector),
  });
});
