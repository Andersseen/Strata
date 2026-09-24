// Nitro bundles `src/server/**` without the Angular linker, so the partially
// compiled Angular packages imported below need the JIT compiler at runtime —
// the same reason Analog's generated server-function module loads it. The bare
// import survives Nitro's tree-shaking only because `vite.config.ts` declares
// it in `nitro.moduleSideEffects`.
import "@angular/compiler";

import { createApplication } from "@angular/platform-browser";
import { platformServer, provideServerRendering } from "@angular/platform-server";
import { registerControllers } from "@strata/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { createAngularControllerFactory } from "../strata/angular-di/angular-controller-factory";
import { CatalogController } from "../strata/angular-di/angular-di.controller";

// Experiment (SPEC-003): Angular DI through `controllerFactory`, owned by the
// consumer. Analog exposes no supported way to reach the injector of an SSR
// render or of its server functions, so this plugin bootstraps its own
// application injector the way Analog bootstraps the one its server functions
// use: `createApplication()` on a server platform, no root component. It is a
// separate injector — `providedIn: 'root'` services here are not the instances
// an SSR render or a server function sees.
export default defineNitroPlugin((nitroApp) => {
  // `provideServerRendering()` sets `ngServerMode` before `platformServer()`
  // runs, which keeps this platform out of Angular's global platform slot: SSR
  // renders keep creating (and destroying) their own platforms.
  const config = { providers: [provideServerRendering()] };
  const platformRef = platformServer();
  const application = createApplication(config, { platformRef });

  nitroApp.hooks.hook("close", async () => {
    (await application).destroy();
    platformRef.destroy();
  });

  registerControllers(nitroApp.router, [CatalogController], {
    controllerFactory: createAngularControllerFactory(
      application.then((appRef) => appRef.injector),
    ),
  });
});
