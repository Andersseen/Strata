import { recordRoute } from "../metadata/controller-metadata.js";
import { normalizePath } from "../utils/normalize-path.js";

/**
 * Marks a controller method as a GET route handler.
 *
 * Only records declarative metadata (method, path, handler name) — it does
 * not invoke the method and does not wire up any HTTP runtime.
 *
 * Supported members: public or protected instance methods with a string name.
 * Static, private (`#name`) and symbol-named methods throw a `TypeError` when
 * the class is defined. The route belongs to the class that declares it; a
 * subclass does not inherit it, even when it overrides the method.
 */
export function Get(path?: string) {
  return function decorateGetRoute<This, Args extends unknown[], Return>(
    _target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): void {
    if (context.static) {
      throw new TypeError(
        `@Get() cannot decorate the static method "${String(context.name)}". Route handlers must be instance methods.`,
      );
    }

    if (context.private) {
      throw new TypeError(
        `@Get() cannot decorate the private method "${String(context.name)}". Route handlers must be public or protected instance methods.`,
      );
    }

    if (typeof context.name !== "string") {
      throw new TypeError("@Get() can only decorate methods with a string name.");
    }

    recordRoute(
      context.metadata,
      Object.freeze({
        method: "GET",
        path: normalizePath(path),
        handler: context.name,
      }),
    );
  };
}
