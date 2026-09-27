import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";

/**
 * The ES module graph actually reachable from a built entry file: static
 * imports, `export … from` and string-literal dynamic `import()`, followed
 * through relative specifiers. Used to tell the Worker that Wrangler executes
 * apart from files that merely sit next to it in the output directory.
 *
 * The input is bundler output (Rollup/Rolldown), whose specifiers are plain
 * string literals, so a lexical scan is enough; it is not a general parser.
 * Static imports are only recognized at a statement boundary, so an error
 * message such as `import "zone.js/…" in your application` is not one.
 */

export interface ModuleGraph {
  /** Reachable modules, relative to the graph root, in discovery order. */
  readonly modules: readonly string[];
  /** Non-relative specifiers imported by a reachable module, with the importer. */
  readonly externals: readonly { readonly specifier: string; readonly importer: string }[];
}

const SPECIFIERS = [
  // `import x from "…"`, `import { … } from "…"`, `export { … } from "…"`, `export * from "…"`
  /(?:^|[;}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*)?from\s*["']([^"'\n]+)["']/gm,
  // `import "…"` (side effect)
  /(?:^|[;}])\s*import\s*["']([^"'\n]+)["']/gm,
  // `import("…")`
  /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
];

function specifiersOf(source: string): string[] {
  const found = SPECIFIERS.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]!));

  // A `${…}` specifier is a template literal in a message, never a module.
  return [...new Set(found.filter((specifier) => !specifier.includes("${")))];
}

export function moduleGraph(root: string, entry: string): ModuleGraph {
  const modules: string[] = [];
  const externals: { specifier: string; importer: string }[] = [];
  const pending = [join(root, entry)];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const file = pending.shift()!;

    if (seen.has(file)) continue;
    seen.add(file);
    modules.push(relative(root, file));

    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = join(dirname(file), specifier);

        if (existsSync(target)) pending.push(target);
        else externals.push({ specifier, importer: relative(root, file) });
      } else {
        externals.push({ specifier, importer: relative(root, file) });
      }
    }
  }

  return { modules, externals };
}

/** `node:*` or a bare Node built-in name (`fs`, `path/posix`, …). */
export function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0]!);
}
