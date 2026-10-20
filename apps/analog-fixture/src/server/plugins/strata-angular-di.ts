// Nitro bundles `src/server/**` without the Angular linker, so the partially
// compiled Angular packages imported below need the JIT compiler at runtime —
// the same reason Analog's generated server-function module loads it. The bare
// import survives Nitro's tree-shaking only because `vite.config.ts` declares
// it in `nitro.moduleSideEffects`.
import "@angular/compiler";

import { createApplication } from "@angular/platform-browser";
import { platformServer, provideServerRendering } from "@angular/platform-server";
import { registerControllers } from "@strata-sc/analog";
import type {
  StrataAnalogGuard,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
} from "@strata-sc/analog";
import { defineNitroPlugin } from "nitropack/runtime";

import { createAngularControllerFactory } from "../strata/angular-di/angular-controller-factory";
import { CatalogController } from "../strata/angular-di/angular-di.controller";
import {
  compositionStats,
  getCompositionTrace,
  REQUEST_CONFIGURATION,
  angularDiStats,
  rememberVerifiedPrincipal,
  setCompositionTrace,
} from "../strata/angular-di/providers";

const credentials = new Map<string, "alpha" | "beta">([
  ["fixture-alpha", "alpha"],
  ["fixture-beta", "beta"],
]);
const owners = new Map([
  ["alpha-product", "alpha"],
  ["beta-product", "beta"],
  ["not-a-number", "alpha"],
]);
const isComposedRoute = (path: string) => path.startsWith("/api/strata/angular-di/protected/");

const compositionGuard: StrataAnalogGuard = async ({ request, route, onCleanup }) => {
  if (!isComposedRoute(route.path)) return { allow: true };
  setCompositionTrace(request, []);
  compositionStats.guardEntered++;
  onCleanup(() => {
    compositionStats.guardCleanups++;
    const trace = getCompositionTrace(request);
    if (!trace) return;
    trace.push("cleanup:guard");
    if (trace.includes("timing:before")) {
      compositionStats.cleanupOrderChecks++;
      const expected = trace.includes("cleanup:injector")
        ? ["cleanup:injector", "cleanup:outcome", "cleanup:timing", "cleanup:guard"]
        : ["cleanup:outcome", "cleanup:timing", "cleanup:guard"];
      if (JSON.stringify(trace.slice(-expected.length)) !== JSON.stringify(expected)) {
        compositionStats.cleanupOrderFailures++;
      }
    }
    if (request.query["cleanupFailure"] === "all" || request.query["cleanupFailure"] === "guard") {
      throw new Error("Request cleanup failed.");
    }
  });
  await Promise.resolve();
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const principal = credentials.get(token);
  if (!principal) return { allow: false, status: 401 };
  const id = request.params["id"] ?? "";
  const owner = owners.get(id) ?? (/^\d+$/.test(id) ? principal : undefined);
  if (owner !== principal) return { allow: false, status: 403 };
  rememberVerifiedPrincipal(request, principal);
  return { allow: true };
};

const timingInterceptor: StrataAnalogInterceptor = async ({ request, route, onCleanup }, next) => {
  if (!isComposedRoute(route.path)) return next();
  const trace = requireCompositionTrace(request);
  trace.push("timing:before");
  compositionStats.interceptorEvents++;
  onCleanup(() => {
    compositionStats.interceptorCleanups++;
    getCompositionTrace(request)?.push("cleanup:timing");
  });
  // This observation cleanup deliberately participates in Strata's shared LIFO scope.
  if (request.query["cleanupFailure"] === "all" || request.query["cleanupFailure"] === "timing") {
    onCleanup(() => {
      throw new Error("Request cleanup failed.");
    });
  }
  try {
    const result = await next();
    recordInjectorAliveDuringUnwind(request);
    trace.push("timing:after");
    return addTrace(result, trace);
  } catch (error) {
    recordInjectorAliveDuringUnwind(request);
    trace.push("timing:error");
    throw error;
  }
};

const outcomeInterceptor: StrataAnalogInterceptor = async ({ request, route, onCleanup }, next) => {
  if (!isComposedRoute(route.path)) return next();
  const trace = requireCompositionTrace(request);
  trace.push("outcome:before");
  compositionStats.interceptorEvents++;
  onCleanup(() => {
    compositionStats.interceptorCleanups++;
    getCompositionTrace(request)?.push("cleanup:outcome");
  });
  if (request.query["cleanupFailure"] === "all" || request.query["cleanupFailure"] === "outcome") {
    onCleanup(() => {
      throw new Error("Request cleanup failed.");
    });
  }
  try {
    if (request.query["interceptorFailure"] === "before") {
      throw new Error("Request failed.");
    }
    const result = await next();
    recordInjectorAliveDuringUnwind(request);
    trace.push("outcome:after");
    if (request.query["interceptorFailure"] === "after") {
      throw new Error("Request failed.");
    }
    return addTrace(result, trace);
  } catch (error) {
    recordInjectorAliveDuringUnwind(request);
    trace.push("outcome:error");
    throw error;
  }
};

function addTrace(result: unknown, trace: string[]): unknown {
  if (
    result instanceof Response ||
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    return result;
  }
  return { ...result, interceptorOrder: [...trace] };
}

function requireCompositionTrace(request: StrataAnalogRequest): string[] {
  const trace = getCompositionTrace(request);
  if (!trace) throw new Error("Request lifecycle trace is unavailable.");
  return trace;
}

function recordInjectorAliveDuringUnwind(request: StrataAnalogRequest): void {
  const trace = getCompositionTrace(request);
  if (!trace?.includes("injector:created")) return;
  compositionStats.interceptorLiveChecks++;
  if (trace.includes("cleanup:injector") || angularDiStats.injectorsAlive < 1) {
    compositionStats.interceptorLiveFailures++;
  }
}

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
  const config = {
    providers: [
      provideServerRendering(),
      { provide: REQUEST_CONFIGURATION, useValue: "application" },
    ],
  };
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
    guards: [compositionGuard],
    interceptors: [timingInterceptor, outcomeInterceptor],
  });
});
