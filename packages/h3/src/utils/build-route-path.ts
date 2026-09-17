/**
 * Joins an already-normalized controller path and route path (as produced by
 * `@strata/core`'s `normalizePath`) into the final path H3 should register.
 *
 * Both inputs are guaranteed by `@strata/core` to start with exactly one
 * leading "/" and never end with a trailing "/" unless they are the root
 * path "/", so joining only needs to avoid a doubled or missing "/" at the
 * root case:
 *
 * - "/users" + "/"    -> "/users"
 * - "/users" + "/:id" -> "/users/:id"
 * - "/"      + "/health" -> "/health"
 */
export function buildRoutePath(controllerPath: string, routePath: string): string {
  if (controllerPath === "/") {
    return routePath;
  }

  if (routePath === "/") {
    return controllerPath;
  }

  return `${controllerPath}${routePath}`;
}
