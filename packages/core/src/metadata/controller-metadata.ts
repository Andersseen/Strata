import "./decorator-metadata-polyfill.js";

import type { ControllerDefinition } from "../controller/controller.types.js";
import type { RouteDefinition } from "../route/route.types.js";

/**
 * Private keys used to stash Strata's own data inside the standard decorator
 * metadata object (`context.metadata`, later exposed as `Class[Symbol.metadata]`).
 * Nothing outside this module ever sees these symbols, so consumers can't
 * accidentally read or clobber Strata's metadata by guessing a property name.
 *
 * Ownership: Strata metadata belongs to the class that declares it. The
 * standard gives a subclass's metadata object its base class's metadata as
 * prototype, and an undecorated subclass resolves `Symbol.metadata` straight
 * to its base class's object. Every access here is therefore own-property
 * only, so controller and route metadata are never implicitly inherited, and
 * a subclass never appends to its base class's route list.
 */
const ROUTES = Symbol("strata:routes");
const DEFINITION = Symbol("strata:controller-definition");

function readOwn<T>(metadata: DecoratorMetadata, key: symbol): T | undefined {
  return Object.hasOwn(metadata, key) ? (metadata[key] as T) : undefined;
}

export function recordRoute(metadata: DecoratorMetadata, route: RouteDefinition): void {
  const routes = readOwn<RouteDefinition[]>(metadata, ROUTES);

  if (routes) {
    routes.push(route);
  } else {
    metadata[ROUTES] = [route];
  }
}

export function recordController(metadata: DecoratorMetadata, path: string): void {
  const routes = readOwn<RouteDefinition[]>(metadata, ROUTES) ?? [];
  const definition: ControllerDefinition = Object.freeze({
    path,
    routes: Object.freeze([...routes]),
  });
  metadata[DEFINITION] = definition;
}

export function readControllerDefinition(target: object): ControllerDefinition | undefined {
  if (!Object.hasOwn(target, Symbol.metadata)) {
    return undefined;
  }

  const metadata = (target as { [Symbol.metadata]?: DecoratorMetadata | null })[Symbol.metadata];

  return metadata ? readOwn<ControllerDefinition>(metadata, DEFINITION) : undefined;
}
