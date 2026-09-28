/**
 * Build-time marker for a server component, stacked on `@Component`. It does
 * nothing at runtime: the `@strata-sc/server-components/vite` transform finds
 * classes decorated with it in source and replaces their module in the
 * browser graph with a generated surrogate. Experimental, not public API.
 */
export function ServerComponent(): ClassDecorator {
  return (target) => target;
}
