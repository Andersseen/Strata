import { recordRoute } from "../metadata/controller-metadata.js";
import { normalizePath } from "../utils/normalize-path.js";

import type { HttpMethod } from "./route.types.js";

/**
 * Builds a public HTTP route decorator (`@Get()`, `@Post()`, …) for one
 * method. Internal to `@strata-sc/core`: the public API stays one explicit
 * decorator per method.
 *
 * Every route decorator shares the same contract: it only records declarative
 * metadata (method, normalized path, handler name) on the declaring class, in
 * declaration order, as a frozen record. It accepts public or protected
 * instance methods with a string name; static, private (`#name`) and
 * symbol-named methods throw a `TypeError` naming `decoratorName` when the
 * class is defined.
 */
export function createRouteDecorator(method: HttpMethod, decoratorName: string) {
  return function routeDecorator(path?: string) {
    return function decorateRoute<This, Args extends unknown[], Return>(
      _target: (this: This, ...args: Args) => Return,
      context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
    ): void {
      if (context.static) {
        throw new TypeError(
          `@${decoratorName}() cannot decorate the static method "${String(context.name)}". Route handlers must be instance methods.`,
        );
      }

      if (context.private) {
        throw new TypeError(
          `@${decoratorName}() cannot decorate the private method "${String(context.name)}". Route handlers must be public or protected instance methods.`,
        );
      }

      if (typeof context.name !== "string") {
        throw new TypeError(`@${decoratorName}() can only decorate methods with a string name.`);
      }

      recordRoute(
        context.metadata,
        Object.freeze({
          method,
          path: normalizePath(path),
          handler: context.name,
        }),
      );
    };
  };
}
