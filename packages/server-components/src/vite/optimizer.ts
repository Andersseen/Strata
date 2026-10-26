import { browserGraphError } from "./diagnostics.js";
import type { BrowserGraphContext } from "./diagnostics.js";
import { SERVER_ONLY_SPECIFIER } from "./server-only.js";

/** Upward steps of the importer chain the optimizer firewall follows before it stops. */
const MAX_CHAIN = 12;

/** The slice of Rolldown's plugin context the firewall uses; both members are public API. */
interface OptimizerPluginContext {
  error(message: string): never;
  getModuleInfo(id: string): { readonly importers?: readonly string[] } | null;
}

/**
 * A Rolldown plugin for `optimizeDeps.rolldownOptions.plugins`.
 *
 * Vite pre-bundles a dependency for the browser before the module graph sees
 * it: the dependency's internal imports, including a package's own
 * `import "<SERVER_ONLY_SPECIFIER>"`, are resolved by the optimizer and not by
 * the Vite plugin's `resolveId`. Without this plugin a package module that
 * asserts server-only (directly, through a package barrel, or through a
 * dynamic import) is bundled into a chunk the dev server then serves.
 *
 * Every module the optimizer or its dependency scan loads is bound for the
 * browser, so reaching the assertion from any of them fails that run. A
 * failed run produces no chunk, so there is nothing forbidden to serve.
 *
 * The failure is raised when the module graph is complete (`buildEnd`), not at
 * the import, because only then does the optimizer report who imports the
 * asserting module. The state lives in the returned plugin, per run.
 */
export function serverOnlyOptimizerPlugin(context: BrowserGraphContext) {
  const asserting = new Set<string>();

  return {
    name: "strata:server-only-optimizer",
    buildStart() {
      asserting.clear();
    },
    resolveId(source: string, importer: string | undefined) {
      if (source === SERVER_ONLY_SPECIFIER && importer) asserting.add(importer);

      return null;
    },
    buildEnd(this: OptimizerPluginContext) {
      const [id] = asserting;

      if (id === undefined) return;

      const above = importersAbove(this, id);

      this.error(
        browserGraphError({ kind: "server-only-optimized" }, id, above.at(-1), context, above),
      );
    },
  };
}

/** The importers the optimizer knows above `id`, outermost first, `id` excluded. */
function importersAbove(plugin: OptimizerPluginContext, id: string): string[] {
  const chain: string[] = [];

  for (let current = id; chain.length < MAX_CHAIN;) {
    const next = plugin.getModuleInfo(current)?.importers?.[0];

    if (next === undefined || next === id || chain.includes(next)) break;

    chain.unshift(next);
    current = next;
  }

  return chain;
}
