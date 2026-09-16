import "./decorator-metadata-polyfill.js";

import type { ControllerDefinition } from "../controller/controller.types.js";
import type { RouteDefinition } from "../route/route.types.js";

/**
 * Private keys used to stash Strata's own data inside the standard decorator
 * metadata object (`context.metadata`, later exposed as `Class[Symbol.metadata]`).
 * Nothing outside this module ever sees these symbols, so consumers can't
 * accidentally read or clobber Strata's metadata by guessing a property name.
 */
const ROUTES = Symbol("strata:routes");
const DEFINITION = Symbol("strata:controller-definition");

export function recordRoute(metadata: DecoratorMetadata, route: RouteDefinition): void {
  const routes = (metadata[ROUTES] as RouteDefinition[] | undefined) ?? [];
  routes.push(route);
  metadata[ROUTES] = routes;
}

export function recordController(metadata: DecoratorMetadata, path: string): void {
  const routes = (metadata[ROUTES] as RouteDefinition[] | undefined) ?? [];
  const definition: ControllerDefinition = Object.freeze({
    path,
    routes: Object.freeze([...routes]),
  });
  metadata[DEFINITION] = definition;
}

export function readControllerDefinition(target: object): ControllerDefinition | undefined {
  const metadata = (target as { [Symbol.metadata]?: DecoratorMetadata })[Symbol.metadata];
  return metadata?.[DEFINITION] as ControllerDefinition | undefined;
}
