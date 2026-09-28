import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Plugin } from "vite";

import { RUNTIME_PACKAGE, analyzeServerComponent } from "./analyze.js";
import { renderSurrogate } from "./surrogate.js";
import type { ServerComponentModule } from "./surrogate.js";

/**
 * Experimental build transform of the server-component graph
 * (docs/research/server-component-graph-poc.md). Not public API.
 *
 * A module declaring a `@ServerComponent()` class is replaced, in Vite's
 * `client` environment only, by a generated surrogate: an ordinary Angular
 * component with the same selector, an empty template, and the server
 * component's interactive imports as client references. Every other
 * environment (`ssr`, and therefore Nitro) keeps the real module. The
 * surrogate is written into the consuming app so its Angular compiler
 * AOT-compiles it like any other source file.
 */
export interface ServerComponentsOptions {
  /** The Analog app root (the directory holding `vite.config.ts`). */
  readonly root: string;
  /** App-relative directory scanned for `@ServerComponent()` classes. */
  readonly sourceDir: string;
  /**
   * App-relative directory the surrogates are generated into. Must be in the
   * app's Angular program, outside `sourceDir` or excluded from it, and gitignored.
   */
  readonly generatedDir: string;
  /** `false` keeps the real modules in the browser graph: the plain-SSR control build. */
  readonly enabled: boolean;
}

const SOURCE_EXTENSION = ".ts";

export function strataServerComponents(options: ServerComponentsOptions): Plugin {
  const root = resolve(options.root);
  const sourceDir = join(root, options.sourceDir);
  const generatedDir = join(root, options.generatedDir);
  let bySource = new Map<string, ServerComponentModule>();

  const generate = (): void => {
    rmSync(generatedDir, { recursive: true, force: true });
    bySource = new Map();

    for (const file of listSourceFiles(sourceDir, generatedDir)) {
      const found = analyzeServerComponent(file, readFileSync(file, "utf8"));

      if (!found) continue;

      const surrogate = join(generatedDir, relative(sourceDir, file));
      const module: ServerComponentModule = { file, surrogate, ...found };

      mkdirSync(dirname(surrogate), { recursive: true });
      writeFileSync(surrogate, renderSurrogate(module, root));
      bySource.set(file, module);
    }
  };

  return {
    name: "strata:server-components",
    enforce: "pre",

    // Runs before Analog reads its tsconfig, so the surrogates are in the
    // Angular program from the start.
    config() {
      generate();

      // The runtime is Angular partial-compiled. A linked workspace package is
      // not pre-bundled by default, and the dev server links Angular libraries
      // only while pre-bundling; unlinked, they fall back to the JIT compiler,
      // which the browser does not load. Production builds link in the build
      // optimizer instead, so this only affects `vite` dev.
      return { optimizeDeps: { include: [RUNTIME_PACKAGE] } };
    },

    async resolveId(source, importer, resolveOptions) {
      if (!options.enabled || this.environment.name !== "client" || !importer) return null;
      if (!source.startsWith(".") && !source.startsWith("/")) return null;

      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      const module = resolved && bySource.get(stripQuery(resolved.id));

      return module ? module.surrogate : null;
    },

    // A server component module reaching the browser graph by any other path
    // (e.g. a glob import that bypasses resolveId) fails the build instead of leaking.
    load(id) {
      if (!options.enabled || this.environment.name !== "client") return null;

      const module = bySource.get(stripQuery(id));

      if (module) {
        this.error(
          `Server component module ${relative(root, module.file)} entered the browser graph.`,
        );
      }

      return null;
    },
  };
}

function stripQuery(id: string): string {
  return id.split("?")[0] ?? id;
}

function listSourceFiles(dir: string, exclude: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (path !== exclude) files.push(...listSourceFiles(path, exclude));
    } else if (entry.name.endsWith(SOURCE_EXTENSION) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }

  return files.sort();
}
