/**
 * Fixture-local build-time marker for the server-component graph PoC. It does
 * nothing at runtime: `tools/server-components/vite-plugin.ts` finds classes
 * decorated with it in source and replaces their module in the browser graph.
 * Not public API — see docs/research/server-component-graph-poc.md.
 */
export function ServerComponent(): ClassDecorator {
  return (target) => target;
}
