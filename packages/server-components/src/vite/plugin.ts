import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import type { DevEnvironment, EnvironmentModuleNode, Plugin, Rollup, ViteDevServer } from "vite";

type PluginContext = Rollup.PluginContext;

import { RUNTIME_PACKAGE, validateExternalClientComponents } from "./analyze.js";
import type { ExternalClientComponent } from "./analyze.js";
import { aotIntegrityMessage, inspectCompiledModule } from "./aot-integrity.js";
import { browserGraphError, displayPath } from "./diagnostics.js";
import type { BrowserForbidden, BrowserGraphContext, ImportChain } from "./diagnostics.js";
import {
  EMPTY_GRAPH,
  buildServerComponentGraph,
  decideReload,
  diffGraphs,
  syncGeneratedFiles,
} from "./graph.js";
import type {
  GeneratedFiles,
  GeneratedSync,
  GraphDiff,
  ReloadDecision,
  ServerComponentGraph,
} from "./graph.js";
import { stripQuery } from "./module-id.js";
import { createModuleResolver, findTsconfig } from "./resolve.js";
import type { ViteAlias } from "./resolve.js";
import { SERVER_ONLY_SPECIFIER } from "./server-only.js";

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
 *
 * Under `vite` (dev) the graph is derived again after every source edit that
 * can change it (docs/research/server-component-dev-hmr.md), as one
 * transaction: the next graph is analyzed completely, and only then are the
 * generated surrogates synchronized and the graph swapped in. An edit to
 * anything a server render depends on reloads the document, because that
 * implementation is not in the browser graph and cannot be hot-patched there;
 * any other edit is left to Angular and Vite. While the graph cannot be
 * derived, the client environment fails closed.
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
  /** Explicitly approved Angular package components usable as [strataClient] boundaries. */
  readonly clientComponents?: readonly ExternalClientComponent[];
  /**
   * App-relative tsconfig whose `paths` / `baseUrl` the graph analysis follows
   * when it resolves re-exports. Defaults to `tsconfig.app.json`, then
   * `tsconfig.json`, in the app root. Vite's `resolve.alias` is always read from
   * the resolved config.
   */
  readonly tsconfig?: string;
  /**
   * `false` keeps the real modules in the browser graph: the plain-SSR control build.
   * Omitted means `true`: a config that forgets the option must not silently ship
   * Server Component implementations to the browser.
   */
  readonly enabled?: boolean;
}

const SOURCE_EXTENSION = ".ts";
const SOURCE_FILE = /\.(ts|html)$/;
/** How long a reload waits for the dev watcher to report the surrogates just written. */
const SURROGATE_EVENT_TIMEOUT_MS = 2_000;
const PLUGIN_NAME = "strata:server-components";

const nodeGeneratedFiles: GeneratedFiles = {
  list: (dir) => (existsSync(dir) ? listFiles(dir) : []),
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  remove: (path) => rmSync(path, { force: true }),
  pruneEmpty(dir, stop) {
    for (let current = dir; current !== stop && current.startsWith(stop + sep);) {
      if (readdirSync(current).length > 0) return;

      rmdirSync(current);
      current = dirname(current);
    }
  },
};

/** One source edit as the dev server reports it, shared by the environments it visits. */
type Pass =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "refreshed";
      readonly decision: ReloadDecision;
      readonly sync: GeneratedSync;
      readonly diff: GraphDiff;
      readonly milliseconds: number;
    }
  | { readonly kind: "failed"; readonly message: string };

/** A reload held back until the watcher has reported the surrogates written for it. */
interface PendingReload {
  readonly awaiting: Set<string>;
  readonly reasons: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Walks up from the app root like a bundler does; `NODE_PATH` (set by pnpm) must not count. */
function hasAngularRouter(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "@angular", "router", "package.json"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

export function strataServerComponents(options: ServerComponentsOptions): Plugin {
  const clientComponents = validateExternalClientComponents(
    (options as { readonly clientComponents?: unknown }).clientComponents,
  );
  const enabled = options.enabled ?? true;
  const root = resolve(options.root);
  const sourceDir = join(root, options.sourceDir);
  const generatedDir = join(root, options.generatedDir);
  /** The last graph that analyzed completely. Replaced as a unit, never edited. */
  let graph: ServerComponentGraph = EMPTY_GRAPH;
  /**
   * Set while the sources cannot be analyzed into a graph (dev only). The
   * committed `graph` is then stale as safety metadata, so the client
   * environment refuses every app module until a refresh succeeds.
   */
  let failure: string | undefined;
  let devServer: ViteDevServer | undefined;
  /** The client environment's `resolve.alias`; known once the config is resolved. */
  let aliases: readonly ViteAlias[] = [];
  const tsconfigPath = options.tsconfig ? resolve(root, options.tsconfig) : findTsconfig(root);
  let pending: PendingReload | undefined;
  const passes = new Map<string, Pass>();
  /**
   * Production builds only: first parent of each module in the `client`
   * environment, recorded as modules are parsed, because the bundler does not
   * report a module's importers until its graph is linked, which is after the
   * diagnostic is needed. One build's worth of edges, dropped at the next
   * `buildStart`; the dev server uses its own module graph instead.
   */
  const parents = new Map<string, string>();
  /** True for `vite build`: the compilation contract and the build barrier apply to builds only. */
  let building = false;
  /**
   * Environments of this build that have started and not yet finished
   * transforming, with the callers waiting for the last one to leave.
   * See {@link leaveBuild}.
   */
  const activeBuilds = new Set<string>();
  let drainWaiters: Array<() => void> = [];

  const context: BrowserGraphContext = {
    root,
    get serverOnly() {
      return graph.serverOnly;
    },
    surrogateOf: (id) => graph.bySurrogate.get(stripQuery(id))?.file,
  };

  /**
   * Derives the graph from the sources as they are right now and swaps it in:
   * analyze everything first (a throw leaves `graph` and the generated files
   * exactly as they were), then synchronize the surrogates, then replace the
   * graph. Throws the analysis error.
   */
  const refresh = (): { next: ServerComponentGraph; sync: GeneratedSync } => {
    // One read per file per refresh, so every analysis step sees the same sources.
    const reads = new Map<string, string>();
    const readFile = (path: string): string => {
      let text = reads.get(path);

      if (text === undefined) {
        text = readFileSync(path, "utf8");
        reads.set(path, text);
      }

      return text;
    };
    const next = buildServerComponentGraph({
      root,
      sourceDir,
      generatedDir,
      clientComponents,
      files: listSourceFiles(sourceDir, generatedDir),
      readFile,
      // A resolver per generation: its TypeScript resolution cache is dropped
      // with the graph, so a changed tsconfig or file layout is never stale.
      resolver: (modules) =>
        createModuleResolver({ root, modules, aliases, tsconfig: tsconfigPath }),
    });
    const sync = syncGeneratedFiles(generatedDir, next.generated, nodeGeneratedFiles);

    graph = next;
    failure = undefined;

    return { next, sync };
  };

  /** The module behind `id` if the client environment must never load it. */
  const forbiddenIn = (id: string): BrowserForbidden | undefined => {
    const file = stripQuery(id);
    const component = graph.bySource.get(file);

    if (component) return { kind: "server-component", file };

    const module = graph.serverOnly.get(file);

    return module ? { kind: "server-only", module } : undefined;
  };

  const failClosedMessage = (): string =>
    `[strata] The Server Component graph could not be refreshed, so the browser graph is closed until it can: ${failure}`;

  const inApp = (id: string): boolean => {
    const file = stripQuery(id);

    return isInside(sourceDir, file) || isInside(generatedDir, file);
  };

  /** What a source edit means for the graph; computed once per watcher event. */
  const passFor = (type: string, file: string, timestamp: number, server: ViteDevServer): Pass => {
    const key = `${type}\0${file}\0${timestamp}`;
    const known = passes.get(key);

    if (known) return known;

    const relevant =
      failure !== undefined ||
      file === tsconfigPath ||
      graph.serverOwnedFiles.has(file) ||
      graph.serverOnly.has(file) ||
      (isInside(sourceDir, file) && SOURCE_FILE.test(file));
    let pass: Pass = { kind: "ignored" };

    if (relevant) {
      const started = performance.now();
      const previous = graph;
      const wasFailed = failure !== undefined;

      try {
        const { next, sync } = refresh();
        const diff = diffGraphs(previous, next);

        // Whatever Vite cached for a surrogate or for a module whose forbidden
        // status flipped was decided under the old graph: drop it now, so the
        // reloaded document cannot be served from it.
        invalidateClient(server, [...sync.written, ...sync.removed, ...diff.forbiddenFlipped]);

        const decision = decideReload(file, previous, next, diff, wasFailed);

        pass = {
          kind: "refreshed",
          decision,
          sync,
          diff,
          milliseconds: performance.now() - started,
        };
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        pass = { kind: "failed", message: failure };
        // Vite answers a request for an already transformed module from its
        // cache, without asking the plugin. Forget them all, so every app
        // module is loaded again, and refused, until the graph can be derived.
        server.environments["client"]?.moduleGraph.invalidateAll();
      }
    }

    passes.set(key, pass);
    // The map only deduplicates the environments of one event; keep it small.
    if (passes.size > 32) passes.delete(passes.keys().next().value as string);

    return pass;
  };

  const sendReload = (server: ViteDevServer, reasons: Iterable<string>): void => {
    server.config.logger.info(
      `[strata] ${[...reasons].join("; ")}: reloading the document for a new server render`,
      { timestamp: true },
    );
    server.environments["client"]?.hot.send({ type: "full-reload", path: "*" });
  };

  const flushPending = (server: ViteDevServer): void => {
    if (!pending) return;

    clearTimeout(pending.timer);
    sendReload(server, pending.reasons);
    pending = undefined;
  };

  /**
   * Reloads once the surrogates written for this edit have been reported by
   * the watcher. Angular recompiles a surrogate when its change event passes
   * through the plugin pipeline; a reload sent earlier could fetch the old
   * compilation.
   */
  const scheduleReload = (server: ViteDevServer, reason: string, written: readonly string[]) => {
    if (written.length === 0 && !pending) {
      sendReload(server, [reason]);

      return;
    }

    pending ??= { awaiting: new Set(), reasons: new Set(), timer: undefined };
    pending.reasons.add(reason);
    for (const path of written) pending.awaiting.add(path);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => flushPending(server), SURROGATE_EVENT_TIMEOUT_MS);
    pending.timer.unref();
  };

  /**
   * An environment leaves the build. With `wait`, resolves only once every
   * environment that started has left, so no environment's `buildEnd`
   * (and Analog's release of the shared compilation) runs while another is
   * still transforming. Each environment leaves before it waits, so the
   * environments cannot wait on each other forever.
   */
  const leaveBuild = async (environment: string | undefined, wait = true): Promise<void> => {
    if (!building || environment === undefined) return;

    activeBuilds.delete(environment);

    if (activeBuilds.size === 0) {
      const waiters = drainWaiters;

      drainWaiters = [];
      for (const resolveWaiter of waiters) resolveWaiter();

      return;
    }

    if (wait) await new Promise<void>((_resolve) => drainWaiters.push(_resolve));
  };

  return {
    name: PLUGIN_NAME,
    enforce: "pre",

    // Runs before Analog reads its tsconfig, so the surrogates are in the
    // Angular program from the start. Hot regeneration is additional.
    config(_config, env) {
      building = env.command === "build";
      refresh();

      // The runtime is Angular partial-compiled. A linked workspace package is
      // not pre-bundled by default, and the dev server links Angular libraries
      // only while pre-bundling; unlinked, they fall back to the JIT compiler,
      // which the browser does not load. Production builds link in the build
      // optimizer instead, so this only affects `vite` dev.
      //
      // The same holds for SSR once the package is installed from a registry or
      // a tarball instead of linked: Vite externalizes `node_modules` for Node
      // SSR, so Nitro would load the partial declarations unlinked and fall back
      // to the JIT compiler. Bundling the runtime through the SSR graph lets
      // Analog's linker process it, as it does for a linked workspace package.
      //
      // The optional `/navigation` entry is Angular partial-compiled too (its
      // injectable and directive), so it is pre-bundled when the app has
      // `@angular/router`, the peer it needs. Apps without a router never load it.
      const linked = [
        RUNTIME_PACKAGE,
        ...(hasAngularRouter(root) ? [`${RUNTIME_PACKAGE}/navigation`] : []),
        ...clientComponents.map((entry) => entry.module),
      ];

      return {
        optimizeDeps: { include: linked },
        ssr: { noExternal: [RUNTIME_PACKAGE, ...clientComponents.map((entry) => entry.module)] },
      };
    },

    // Vite's resolved aliases are the supported source of truth for
    // `resolve.alias` (other plugins' `config()` hooks may add to them), so the
    // graph is derived once more with them. The surrogates do not depend on
    // aliases; the server-only taint of aliased re-exports does.
    configResolved(resolved) {
      if (!enabled) return;

      // `resolve.alias` is shared by every environment.
      aliases = resolved.resolve.alias;
      refresh();
    },

    configureServer(server) {
      devServer = server;
    },

    buildStart() {
      if (this.environment?.name === "client") parents.clear();
      if (building && this.environment) activeBuilds.add(this.environment.name);
    },

    /**
     * Analog builds `client` and `ssr` concurrently, with one shared Angular
     * plugin instance, and that plugin discards its compilation output when
     * the first environment ends (`buildEnd`). An environment still transforming
     * then finds no output for its files, and Analog only skips them, which
     * leaves their decorators for the JIT compiler at runtime. This plugin runs
     * ahead of Analog's, so its `buildEnd` holds each environment at the
     * boundary until every environment of the build has finished transforming.
     * Plain Rollup hooks; no Analog or Angular internals.
     */
    async buildEnd() {
      await leaveBuild(this.environment?.name);
    },

    // `buildEnd` is skipped when a build fails before it; never strand a waiter.
    closeBundle() {
      void leaveBuild(this.environment?.name, false);
    },

    /**
     * The production compilation contract. Runs after every other transform
     * (`order: "post"`), so it sees what Angular's plugin actually emitted:
     * a source-owned module whose Angular decorator is still applied, or a
     * bundled library still holding partial declarations, never compiled.
     * Failing here names the module at build time, instead of the first
     * request of a deployed server answering HTTP 200 with a missing component.
     */
    transform: {
      order: "post",
      handler(code, id) {
        if (!building || id.startsWith("\0")) return null;

        const file = stripQuery(id);

        if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith(".d.ts")) return null;

        // A dependency is checked for unlinked partial declarations only; a
        // source-owned module for both. Dependency decorators are not ours.
        const owned = isInside(root, file) && !file.includes(`${sep}node_modules${sep}`);
        const finding = inspectCompiledModule(code, file);

        if (!finding || (finding.kind === "uncompiled" && !owned)) return null;

        this.error(
          aotIntegrityMessage(
            displayPath(file, root),
            this.environment?.name ?? "unknown",
            finding,
          ),
        );
      },
    },

    moduleParsed(info) {
      if (!enabled || this.environment?.name !== "client") return;

      for (const child of [...info.importedIds, ...info.dynamicallyImportedIds]) {
        if (!parents.has(child)) parents.set(child, info.id);
      }
    },

    /**
     * Public, environment-aware seam of Vite 8 (`handleHotUpdate` is its
     * deprecated predecessor and only sees updates, not creations or
     * deletions). Vite calls it once per environment for every watcher event,
     * the `client` environment first; the pass is computed once and shared.
     *
     * The decision is made after the graph has been derived and committed
     * again, never before, and the reload is sent from the last environment,
     * once.
     */
    hotUpdate(update) {
      const server = devServer ?? update.server;

      if (!enabled) return;

      const file = resolve(update.file);
      const environment = this.environment;
      const isClient = environment.name === "client";
      const last = lastEnvironmentName(server);

      // The plugin's own writes. Never regenerate from them (that would loop);
      // only note that the surrogate reached the pipeline.
      if (isInside(generatedDir, file)) {
        const awaited = pending?.awaiting.has(file) ?? false;

        if (environment.name === last && pending) {
          pending.awaiting.delete(file);
          if (pending.awaiting.size === 0) flushPending(server);
        }

        // Its reload is ours: Vite's own propagation for a changed surrogate
        // would end in a second one.
        return isClient && awaited ? [] : undefined;
      }

      const pass = passFor(update.type, file, update.timestamp, server);

      if (pass.kind === "ignored") return;

      if (pass.kind === "failed") {
        if (environment.name === last) {
          server.config.logger.error(failClosedMessage(), { timestamp: true });
          server.environments["client"]?.hot.send({
            type: "error",
            err: { message: failClosedMessage(), stack: "", plugin: PLUGIN_NAME },
          });
        }

        return isClient ? [] : undefined;
      }

      if (environment.name === last) {
        server.config.logger.info(
          `[strata] graph refreshed in ${pass.milliseconds.toFixed(0)} ms (${update.type} ${file.slice(root.length + 1)})`,
          { timestamp: true },
        );

        if (pass.decision.reload) {
          scheduleReload(server, pass.decision.reason, [
            ...pass.sync.written,
            ...pass.sync.removed,
          ]);
        }
      }

      // A reload makes any module update for this edit moot (and for a
      // server-owned file there is no browser module to update).
      return isClient && pass.decision.reload ? ([] satisfies EnvironmentModuleNode[]) : undefined;
    },

    async resolveId(source, importer, resolveOptions) {
      if (!enabled || this.environment.name !== "client" || !importer) return null;

      // Only a marked module imports the assertion, and a marked module inside
      // sourceDir is stopped at its own import site below. Reaching this means
      // one the pre-scan never saw (outside sourceDir) is being loaded.
      if (source === SERVER_ONLY_SPECIFIER) {
        this.error(
          browserGraphError(
            { kind: "server-only-specifier" },
            importer,
            firstImporter(this, importer, parents),
            context,
            importChain(this, importer, parents).slice(0, -1),
          ),
        );
      }

      // A path is always resolved and checked. A bare specifier is resolved
      // here only when the generation's resolver (Vite aliases, tsconfig
      // `paths`) says it names an app module, so ordinary package imports pay
      // nothing; whatever else Vite resolves is stopped by `load` below.
      if (
        !source.startsWith(".") &&
        !source.startsWith("/") &&
        graph.resolve(source, stripQuery(importer)) === undefined
      ) {
        return null;
      }

      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });

      if (!resolved) return null;

      if (failure !== undefined && inApp(resolved.id)) this.error(failClosedMessage());

      const forbidden = forbiddenIn(resolved.id);

      if (!forbidden) return null;

      // A Server Component imported as a module is replaced by its surrogate.
      // A query import of one (`?raw`, `?url`) would ship its source or its
      // file instead, so that fails like any other server-only module.
      if (forbidden.kind === "server-component" && resolved.id === forbidden.file) {
        return graph.bySource.get(forbidden.file)?.surrogate ?? null;
      }

      this.error(
        browserGraphError(
          forbidden,
          resolved.id,
          importer,
          context,
          importChain(this, importer, parents),
        ),
      );
    },

    // A forbidden module reaching the browser graph by any other path (e.g. a
    // glob import or an alias that bypasses the check above) fails the build
    // instead of leaking.
    load(id) {
      if (!enabled || this.environment.name !== "client") return null;

      if (failure !== undefined && inApp(id)) this.error(failClosedMessage());

      const forbidden = forbiddenIn(id);

      if (forbidden) {
        const importer = firstImporter(this, id, parents);

        this.error(
          browserGraphError(
            forbidden,
            id,
            importer,
            context,
            importer ? importChain(this, importer, parents) : [],
          ),
        );
      }

      return null;
    },
  };
}

/**
 * Who imported `id`, for the diagnostic. Rollup's `getModuleInfo` knows during a
 * build; the dev server throws on `importers`, so it asks its own module graph.
 */
function firstImporter(
  plugin: PluginContext,
  id: string,
  parents: ReadonlyMap<string, string>,
): string | undefined {
  return importersOf(plugin, id, parents)[0];
}

/** Upward steps of an import chain a diagnostic follows before it stops. */
const MAX_CHAIN = 12;

/**
 * The chain of importers above `id`, outermost first and ending at `id`,
 * following the first importer the bundler knows at each step. It stops at an
 * unknown importer, at a cycle and after {@link MAX_CHAIN} steps, so the
 * result is a true prefix of what the bundler knows, never an invention. Under
 * the dev server's optimized dependencies the original importers of a
 * package's internal modules are collapsed into one chunk and are not here.
 */
function importChain(
  plugin: PluginContext,
  id: string,
  parents: ReadonlyMap<string, string>,
): ImportChain {
  const chain = [id];

  for (let current = id; chain.length <= MAX_CHAIN;) {
    const next = importersOf(plugin, current, parents)[0];

    if (next === undefined || chain.includes(next)) break;

    chain.unshift(next);
    current = next;
  }

  return chain;
}

function importersOf(
  plugin: PluginContext,
  id: string,
  parents: ReadonlyMap<string, string>,
): readonly string[] {
  try {
    const known = plugin.getModuleInfo(id)?.importers ?? [];
    const parent = parents.get(id);

    return known.length > 0 ? known : parent === undefined ? [] : [parent];
  } catch {
    const graph = (plugin.environment as Partial<DevEnvironment>).moduleGraph;
    const importers = graph?.getModuleById(id)?.importers;

    return importers ? [...importers].flatMap((node) => (node.id ? [node.id] : [])) : [];
  }
}

function isInside(dir: string, path: string): boolean {
  return path.startsWith(dir + sep);
}

/** The environment whose `hotUpdate` call ends one watcher event: Vite visits `client` first, then the rest. */
function lastEnvironmentName(server: ViteDevServer): string {
  return (
    Object.keys(server.environments)
      .filter((name) => name !== "client")
      .at(-1) ?? "client"
  );
}

/** Drops the `client` environment's cached transform of each file, through the public module graph. */
function invalidateClient(server: ViteDevServer, files: readonly string[]): void {
  const graph = server.environments["client"]?.moduleGraph;

  if (!graph) return;

  const seen = new Set<EnvironmentModuleNode>();

  for (const file of files) {
    for (const module of graph.getModulesByFile(file) ?? []) {
      graph.invalidateModule(module, seen);
    }
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
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
