import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";

/**
 * The ES module graph actually reachable from a built entry file: static
 * imports, `export … from` and (unless disabled) string-literal dynamic
 * `import()`, followed through relative specifiers. Used to tell the Worker
 * that Wrangler executes apart from files that merely sit next to it in the
 * output directory, and a page's eager browser chunks from its lazy ones.
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

const STATIC_SPECIFIERS = [
  // `import x from "…"`, `import { … } from "…"`, `export { … } from "…"`, `export * from "…"`
  /(?:^|[;}])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*)?from\s*["']([^"'\n]+)["']/gm,
  // `import "…"` (side effect)
  /(?:^|[;}])\s*import\s*["']([^"'\n]+)["']/gm,
];
// `import("…")`, and Rolldown's `import(\`…\`)` in the client build
const DYNAMIC_SPECIFIER = /\bimport\(\s*["'`]([^"'`\n]+)["'`]\s*\)/g;

export interface ModuleGraphOptions {
  /** Follow string-literal dynamic `import()` too (default). `false`: the static closure only. */
  readonly dynamic?: boolean;
}

/** The specifiers `source` imports dynamically (`import("./x.js")`). */
export function dynamicSpecifiersOf(source: string): string[] {
  return [...new Set([...source.matchAll(DYNAMIC_SPECIFIER)].map((m) => m[1]!))];
}

function specifiersOf(source: string, dynamic: boolean): string[] {
  const patterns = dynamic ? [...STATIC_SPECIFIERS, DYNAMIC_SPECIFIER] : STATIC_SPECIFIERS;
  const found = patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]!));

  // A `${…}` specifier is a template literal in a message, never a module.
  return [...new Set(found.filter((specifier) => !specifier.includes("${")))];
}

export function moduleGraph(
  root: string,
  entry: string,
  { dynamic = true }: ModuleGraphOptions = {},
): ModuleGraph {
  const modules: string[] = [];
  const externals: { specifier: string; importer: string }[] = [];
  const pending = [join(root, entry)];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const file = pending.shift()!;

    if (seen.has(file)) continue;
    seen.add(file);
    modules.push(relative(root, file));

    for (const specifier of specifiersOf(readFileSync(file, "utf8"), dynamic)) {
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
