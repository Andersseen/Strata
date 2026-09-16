import { recordRoute } from "../metadata/controller-metadata.js";
import { normalizePath } from "../utils/normalize-path.js";

/**
 * Marks a controller method as a GET route handler.
 *
 * Only records declarative metadata (method, path, handler name) — it does
 * not invoke the method and does not wire up any HTTP runtime.
 */
export function Get(path?: string) {
  return function decorateGetRoute<This, Args extends unknown[], Return>(
    _target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): void {
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
