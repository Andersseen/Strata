import { getControllerDefinition } from "@strata/core";
import type { HttpMethod, RouteDefinition } from "@strata/core";

import { StrataAnalogConfigurationError } from "./errors.js";
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
 * Strata's HTTP method names → the lowercase names Nitro's router expects.
 * `satisfies Record<HttpMethod, …>` makes this a compile error, not a silent
 * mis-registration, the day `@strata/core` adds a method.
 */
const ROUTER_METHOD = { GET: "get" } as const satisfies Record<HttpMethod, Lowercase<HttpMethod>>;

type RouterMethod = (typeof ROUTER_METHOD)[HttpMethod];

/**
 * The part of Nitro 2's router that Strata uses: `nitroApp.router`, the
 * `Router` Nitro itself registers its file-system routes on.
 *
 * It is declared structurally, and deliberately, instead of importing
 * `Router` from `h3` or `NitroApp` from `nitropack`:
 *
 * - Analog 2 runs on Nitro 2, which runs on H3 **v1**. `@strata/analog`
 *   never touches an H3 v1 (or v2) type, value or import, so it neither
 *   depends on a Nitro/H3 major nor leaks one into its declarations.
 * - The Nitro `Router` is assignable to this interface as-is — no cast. That
 *   is verified against Nitro's real types by the `test:analog` fixture.
 *
 * The handler is passed as a zero-argument function: H3 calls it with the
 * event, but Strata does not expose the event to controllers yet.
 */
export interface NitroRouter {
  add(path: string, handler: () => unknown, method: RouterMethod): unknown;
}

/**
 * Registers one or more Strata controllers on the Nitro router of an Analog
 * app. Call it from a Nitro server plugin, which is where Nitro hands out the
 * router:
 *
 * ```ts
 * export default defineNitroPlugin((nitroApp) => {
 *   registerControllers(nitroApp.router, [UsersController]);
 * });
 * ```
 *
 * For each controller this:
 *
 * 1. reads its declarative metadata via `getControllerDefinition`;
 * 2. creates a single instance of the controller;
 * 3. registers each `@Get()` route on `router`, joining the controller path
 *    and route path into the final route path;
 * 4. wires each route to invoke the matching zero-argument controller
 *    method and return its result directly to Nitro/H3, which serializes it
 *    natively (objects and arrays become JSON).
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
 * {@link StrataAnalogConfigurationError} immediately, instead of failing on
 * the first matching request.
 *
 * Strata does not replace Nitro or Analog — this only adds routes to the
 * router you pass in. Native Analog routes (`src/server/routes/**`) keep
 * working exactly as before.
 */
export function registerControllers<Router extends NitroRouter>(
  router: Router,
  controllers: readonly ControllerClass[],
): Router {
  for (const controllerClass of controllers) {
    registerController(router, controllerClass);
  }

  return router;
}

function registerController(router: NitroRouter, controllerClass: ControllerClass): void {
  const definition = getControllerDefinition(controllerClass);

  if (!definition) {
    throw new StrataAnalogConfigurationError(
      `"${controllerClass.name}" is not a Strata controller. Did you forget to add @Controller()?`,
    );
  }

  const instance = new controllerClass();

  for (const route of definition.routes) {
    registerRoute(router, controllerClass, instance, definition.path, route);
  }
}

function registerRoute(
  router: NitroRouter,
  controllerClass: ControllerClass,
  instance: object,
  controllerPath: string,
  route: RouteDefinition,
): void {
  const handler = (instance as Record<string, unknown>)[route.handler];

  if (typeof handler !== "function") {
    throw new StrataAnalogConfigurationError(
      `"${controllerClass.name}.${route.handler}" is not callable. @Get() route handlers must be methods.`,
    );
  }

  const path = buildRoutePath(controllerPath, route.path);

  router.add(path, () => handler.call(instance) as unknown, ROUTER_METHOD[route.method]);
}
