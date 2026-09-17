import { getControllerDefinition } from "@strata/core";
import type { RouteDefinition } from "@strata/core";
import type { H3 } from "h3";

import { StrataH3ConfigurationError } from "./errors.js";
import { buildRoutePath } from "./utils/build-route-path.js";

/**
 * A Strata controller class, as passed to {@link registerControllers}.
 *
 * `@strata/core` types controller classes as abstract constructors (it only
 * ever reads their metadata), but this adapter must be able to instantiate
 * them, so it narrows the requirement to a concrete, no-argument
 * constructor.
 */
export type ControllerClass = new () => object;

/**
 * Registers one or more Strata controllers on an H3 app instance.
 *
 * For each controller this:
 *
 * 1. reads its declarative metadata via `getControllerDefinition`;
 * 2. creates a single instance of the controller;
 * 3. registers each `@Get()` route on `app`, joining the controller path
 *    and route path into the final H3 route path;
 * 4. wires each route to invoke the matching zero-argument controller
 *    method and return its result directly to H3.
 *
 * Controller lifecycle (provisional): Strata has no dependency injection or
 * request-scoped lifecycle yet. This function instantiates each controller
 * exactly once, with `new ControllerClass()`, at registration time, and
 * reuses that single instance for every request. This is a deliberately
 * minimal placeholder — not a stable API — until a real controller
 * lifecycle/DI design lands in a later iteration.
 *
 * Registration validates eagerly: a class without `@Controller()` metadata,
 * or a route whose handler isn't a callable method, throws a
 * {@link StrataH3ConfigurationError} immediately, instead of failing on the
 * first matching request.
 *
 * Strata does not replace H3 — this only adds routes to the `app` you
 * already own. Any routes you registered directly on `app` (via `app.get`,
 * etc.) keep working exactly as before.
 */
export function registerControllers(app: H3, controllers: readonly ControllerClass[]): H3 {
  for (const controllerClass of controllers) {
    registerController(app, controllerClass);
  }

  return app;
}

function registerController(app: H3, controllerClass: ControllerClass): void {
  const definition = getControllerDefinition(controllerClass);

  if (!definition) {
    throw new StrataH3ConfigurationError(
      `"${controllerClass.name}" is not a Strata controller. Did you forget to add @Controller()?`,
    );
  }

  const instance = new controllerClass();

  for (const route of definition.routes) {
    registerRoute(app, controllerClass, instance, definition.path, route);
  }
}

function registerRoute(
  app: H3,
  controllerClass: ControllerClass,
  instance: object,
  controllerPath: string,
  route: RouteDefinition,
): void {
  const handler = (instance as Record<string, unknown>)[route.handler];

  if (typeof handler !== "function") {
    throw new StrataH3ConfigurationError(
      `"${controllerClass.name}.${route.handler}" is not callable. @Get() route handlers must be methods.`,
    );
  }

  const path = buildRoutePath(controllerPath, route.path);

  app.on(route.method, path, () => handler.call(instance) as unknown);
}
