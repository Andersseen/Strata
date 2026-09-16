import { recordController } from "../metadata/controller-metadata.js";
import { normalizePath } from "../utils/normalize-path.js";

/**
 * Marks a class as a Strata controller and records its route prefix.
 *
 * This only builds declarative metadata — it does not wire up any HTTP
 * runtime. Use {@link getControllerDefinition} to read it back.
 */
export function Controller(path?: string) {
  return function decorateController<Class extends abstract new (...args: never[]) => unknown>(
    _target: Class,
    context: ClassDecoratorContext<Class>,
  ): void {
    recordController(context.metadata, normalizePath(path));
  };
}
