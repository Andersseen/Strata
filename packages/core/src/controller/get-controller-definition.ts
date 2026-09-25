import { readControllerDefinition } from "../metadata/controller-metadata.js";

import type { ControllerDefinition } from "./controller.types.js";

/**
 * Reads the declarative route metadata recorded by {@link Controller} and its
 * {@link Get} routes, without instantiating or invoking the controller.
 *
 * Returns `undefined` for any class that was never decorated with
 * `@Controller()`.
 *
 * This is the intended way for adapters (e.g. a future `@strata-sc/h3`) to
 * consume a controller's shape — it deliberately avoids exposing how or
 * where that metadata is stored internally.
 */
export function getControllerDefinition(
  target: abstract new (...args: never[]) => unknown,
): ControllerDefinition | undefined {
  return readControllerDefinition(target);
}
