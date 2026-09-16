/**
 * Normalizes a route/controller path fragment so decorator input is
 * predictable regardless of how it was written:
 *
 * - missing/empty -> "/"
 * - always starts with exactly one leading "/"
 * - never ends with a trailing "/" (unless it is the root path)
 * - repeated slashes collapse into one
 */
export function normalizePath(path: string | undefined): string {
  if (!path) {
    return "/";
  }

  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const collapsed = withLeadingSlash.replace(/\/+/g, "/");

  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }

  return collapsed;
}
