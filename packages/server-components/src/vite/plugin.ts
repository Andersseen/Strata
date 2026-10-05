import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Plugin } from "vite";

import { RUNTIME_PACKAGE, analyzeServerComponent, createAnalysisCache } from "./analyze.js";
import { browserGraphError } from "./diagnostics.js";
import type { BrowserForbidden, BrowserGraphContext } from "./diagnostics.js";
import { stripQuery } from "./module-id.js";
import { SERVER_ONLY_SPECIFIER, scanServerOnlyModules } from "./server-only.js";
import type { ServerOnlyModule } from "./server-only.js";
import { renderSurrogate } from "./surrogate.js";
import type { ServerComponentModule } from "./surrogate.js";

/**
 * Experimental build transform of the server-component graph
 * (docs/research/server-component-graph-poc.md). Not public API.
 *
 * A module declaring a `@ServerComponent()` class is replaced, in Vite's
 * `client` environment only, by a generated surrogate: an ordinary Angular
 * component with the same selector, an empty template, and as client
 * references every `[strataClient]` component found by walking the server
 * component's template and, recursively, the templates of the unmarked local
 * components it renders (all server-owned). Every other
 * environment (`ssr`, and therefore Nitro) keeps the real module. The
 * surrogate is written into the consuming app so its Angular compiler
 * AOT-compiles it like any other source file.
 *
 * It is also the browser-graph firewall. A `@ServerComponent()` module is
 * forbidden in the `client` environment automatically; any other app module
 * opts in with `import "@strata-sc/server-components/server-only";`, and so
 * does, implicitly, every module that re-exports one (`export … from`).
 * Resolving or loading a forbidden module in the `client` environment, under
 * any query (`?raw`, `?url`, …), statically or through `import()`, fails the
 * build. Server environments are never restricted.
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
  let bySurrogate = new Map<string, ServerComponentModule>();
  let serverOnly: ReadonlyMap<string, ServerOnlyModule> = new Map();

  const context: BrowserGraphContext = {
    root,
    get serverOnly() {
      return serverOnly;
    },
    surrogateOf: (id) => bySurrogate.get(stripQuery(id))?.file,
  };

  const generate = (): void => {
    rmSync(generatedDir, { recursive: true, force: true });
    bySource = new Map();
    bySurrogate = new Map();

    // Build-scoped: shared by every server component of this generation,
    // so a child module composed under several of them is parsed once.
    const cache = createAnalysisCache();
    const files = listSourceFiles(sourceDir, generatedDir);

    // Explicit assertions, then re-export taint to a fixpoint; replaced (never
    // mutated) by each generation, so nothing survives from a previous build.
    serverOnly = scanServerOnlyModules(files, readSource);

    for (const file of files) {
      const found = analyzeServerComponent(file, readFileSync(file, "utf8"), readSource, cache);

      if (!found) continue;

      const surrogate = join(generatedDir, relative(sourceDir, file));
      const module: ServerComponentModule = { file, surrogate, ...found };

      mkdirSync(dirname(surrogate), { recursive: true });
      writeFileSync(surrogate, renderSurrogate(module, root));
      bySource.set(file, module);
      bySurrogate.set(surrogate, module);
    }
  };

  /** The module behind `id` if the client environment must never load it. */
  const forbiddenIn = (id: string): BrowserForbidden | undefined => {
    const file = stripQuery(id);
    const component = bySource.get(file);

    if (component) return { kind: "server-component", file };

    const module = serverOnly.get(file);

    return module ? { kind: "server-only", module } : undefined;
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

      // Only a marked module imports the assertion, and a marked module inside
      // sourceDir is stopped at its own import site below. Reaching this means
      // one the pre-scan never saw (outside sourceDir) is being loaded.
      if (source === SERVER_ONLY_SPECIFIER) {
        this.error(
          browserGraphError({ kind: "server-only-specifier" }, importer, undefined, context),
        );
      }

      if (!source.startsWith(".") && !source.startsWith("/")) return null;

      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });

      if (!resolved) return null;

      const forbidden = forbiddenIn(resolved.id);

      if (!forbidden) return null;

      // A Server Component imported as a module is replaced by its surrogate.
      // A query import of one (`?raw`, `?url`) would ship its source or its
      // file instead, so that fails like any other server-only module.
      if (forbidden.kind === "server-component" && resolved.id === forbidden.file) {
        return bySource.get(forbidden.file)?.surrogate ?? null;
      }

      this.error(browserGraphError(forbidden, resolved.id, importer, context));
    },

    // A forbidden module reaching the browser graph by any other path (e.g. a
    // glob import or an alias that bypasses the check above) fails the build
    // instead of leaking.
    load(id) {
      if (!options.enabled || this.environment.name !== "client") return null;

      const forbidden = forbiddenIn(id);

      if (forbidden) {
        this.error(browserGraphError(forbidden, id, this.getModuleInfo(id)?.importers[0], context));
      }

      return null;
    },
  };
}

function readSource(path: string): string {
  return readFileSync(path, "utf8");
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
