import { readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { findFreePort, spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
import { findFilesContaining, listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";

/**
 * Shared, private harness of the server-component PoC commands
 * (`pnpm test:server-components`, `pnpm test:server-component-navigation`):
 * the check log, the fixture's production build, the graph scans and the
 * production Nitro server. `pnpm test:server-components:cloudflare` passes its
 * own graphs (the Worker and the Pages assets) to the same scans. Not a
 * package, not public API.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, "..", "..", "..");

export const fixtureDir = join(repoRoot, "apps", "analog-fixture");
export const distDir = join(fixtureDir, "dist");

export const MARKERS = {
  implementation: "STRATA_SERVER_COMPONENT_IMPLEMENTATION_MARKER",
  repository: "STRATA_SERVER_COMPONENT_REPOSITORY_MARKER",
  transitive: "STRATA_TRANSITIVE_SERVER_ONLY_MARKER",
  /** A server component import that is not a client boundary (explicit boundaries). */
  serverOnlyImport: "STRATA_SERVER_ONLY_IMPORT_MARKER",
  client: "STRATA_CLIENT_COMPONENT_MARKER",
  control: "STRATA_ANALOG_CLIENT_CONTROL_MARKER",
} as const;
export const SERVER_ONLY = [
  MARKERS.implementation,
  MARKERS.repository,
  MARKERS.transitive,
  MARKERS.serverOnlyImport,
] as const;
/** A string only `@angular/compiler` contains: the compiler must stay server-side. */
export const ANGULAR_COMPILER_FINGERPRINT = "Unterminated quote";
/**
 * Build-time code the @strata-sc/server-components package boundary must keep
 * out of the browser graph, as strings each source is checked to contain: the
 * TypeScript compiler (a diagnostic key), the package's Vite transform (its
 * plugin name and fail-closed error), and Node built-ins (the specifiers, and
 * the stub Vite substitutes for them in a browser build).
 */
const BUILD_TOOL_FINGERPRINTS = [
  {
    label: "TypeScript compiler",
    needle: "Unterminated_string_literal_1002",
    source: "typescript",
  },
  { label: "Vite plugin (name)", needle: "strata:server-components", source: "plugin" },
  { label: "Vite plugin (load guard)", needle: "entered the browser graph", source: "plugin" },
  { label: "node:fs", needle: "node:fs", source: "plugin" },
  { label: "node:path", needle: "node:path", source: "plugin" },
  { label: "Vite's Node built-in stub", needle: "__vite-browser-external", source: null },
] as const;
/** Module names that would reveal server-only source layout in a browser file name. */
const SERVER_FILE_NAMES = [
  "product-details",
  "product-repository",
  "server-secret",
  "server-price",
];

/** Where the browser graph ends up: Vite's client build and Nitro's public assets. */
export const BROWSER_DIRS = ["client", "analog/public"] as const;
/** Where the server graph ends up: Vite's SSR build and Nitro's server (incl. traced node_modules). */
export const SERVER_DIRS = ["ssr", "analog/server"] as const;

let failures = 0;

export function check(name: string, passed: boolean, detail = ""): boolean {
  if (!passed) failures++;
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed || !detail ? "" : ` — ${detail}`}`);

  return passed;
}

export function section(title: string): void {
  console.log(`\n## ${title}`);
}

export function finish(title: string): never {
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${title} — ${failures} failing check(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Production build of the fixture; ends the run (via `onFailure`) if it fails.
 * Returns the build's console output.
 */
export function build(label: string, env: NodeJS.ProcessEnv, onFailure: () => never): string {
  rmSync(distDir, { recursive: true, force: true });

  // A key set to `undefined` in `env` removes it from the inherited environment.
  const result = run("pnpm", ["exec", "vite", "build"], {
    cwd: fixtureDir,
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined),
    ),
  });

  check(`${label}: production build exits 0`, result.status === 0, result.stderr.slice(-2_000));
  if (result.status !== 0) onFailure();

  return `${result.stdout}\n${result.stderr}`;
}

/** Files under the given dist subdirectories that contain `needle`. */
export function filesWith(dirs: readonly string[], needle: string): string[] {
  return dirs.flatMap((dir) =>
    findFilesContaining(join(distDir, dir), needle).map((f) => `${dir}/${f}`),
  );
}

/** A set of build output files, as paths relative to `dist/`. */
export interface OutputGraph {
  readonly label: string;
  readonly files: readonly string[];
}

/** Every file under the given `dist/` subdirectories, minus those `exclude` rejects. */
export function dirGraph(
  label: string,
  dirs: readonly string[],
  exclude: (file: string) => boolean = () => false,
): OutputGraph {
  return {
    label,
    files: dirs
      .flatMap((dir) => listFiles(join(distDir, dir)).map((file) => `${dir}/${file}`))
      .filter((file) => !exclude(file)),
  };
}

/** Files of `graph` whose contents include `needle`. */
export function graphFilesWith(graph: OutputGraph, needle: string): string[] {
  return graph.files.filter((file) => readFileSync(join(distDir, file), "utf8").includes(needle));
}

const nodeBrowserGraph = (): OutputGraph =>
  dirGraph("dist/client, dist/analog/public", BROWSER_DIRS);

export interface GraphSize {
  readonly jsFiles: number;
  readonly jsBytes: number;
  readonly jsGzipBytes: number;
  readonly allFiles: number;
  readonly allBytes: number;
}

export function measure(graph: OutputGraph): GraphSize {
  const size = (file: string) => statSync(join(distDir, file)).size;
  const js = graph.files.filter((file) => /\.m?js$/.test(file));

  return {
    jsFiles: js.length,
    jsBytes: js.reduce((sum, file) => sum + size(file), 0),
    jsGzipBytes: js.reduce(
      (sum, file) => sum + gzipSync(readFileSync(join(distDir, file))).length,
      0,
    ),
    allFiles: graph.files.length,
    allBytes: graph.files.reduce((sum, file) => sum + size(file), 0),
  };
}

/** Build-artifact scan of the browser graph of a PoC build. */
export function checkBrowserGraph(graph: OutputGraph = nodeBrowserGraph()): void {
  section(`Browser graph (${graph.label})`);

  for (const marker of SERVER_ONLY) {
    const found = graphFilesWith(graph, marker);

    check(`${marker} absent`, found.length === 0, found.join(", "));
  }

  for (const marker of [MARKERS.client, MARKERS.control]) {
    const found = graphFilesWith(graph, marker);

    check(`${marker} present (${found.join(", ")})`, found.length > 0, "not found");
  }

  const leakedNames = graph.files.filter((file) =>
    SERVER_FILE_NAMES.some((name) => file.includes(name)),
  );
  const compilerInBrowser = graphFilesWith(graph, ANGULAR_COMPILER_FINGERPRINT);

  check(
    "no browser file is named after a server-only module",
    leakedNames.length === 0,
    leakedNames.join(", "),
  );
  check(
    "@angular/compiler absent from the browser output",
    compilerInBrowser.length === 0,
    compilerInBrowser.join(", "),
  );
  checkNoBuildTools(graph);
  console.log(`browser files scanned (incl. maps/manifests if any): ${graph.files.join(", ")}`);
}

/**
 * The package's runtime entry (`@strata-sc/server-components`, imported by the
 * surrogate) must not drag its build entry (`/vite`) or what that uses into
 * the browser graph.
 */
function checkNoBuildTools(graph: OutputGraph): void {
  const require = createRequire(join(repoRoot, "packages", "server-components", "package.json"));
  const sources = {
    typescript: readFileSync(require.resolve("typescript"), "utf8"),
    plugin: readFileSync(
      join(repoRoot, "packages", "server-components", "dist", "vite.js"),
      "utf8",
    ),
  };

  for (const { label, needle, source } of BUILD_TOOL_FINGERPRINTS) {
    if (
      source &&
      !check(`fingerprint of ${label} occurs in its source`, sources[source].includes(needle))
    ) {
      continue;
    }

    const found = graphFilesWith(graph, needle);

    check(`${label} absent from the browser output`, found.length === 0, found.join(", "));
  }
}

export interface ServerGraphs {
  /** Where the server-only markers must be found. */
  readonly markers: OutputGraph;
  /** What the server runtime executes: `@angular/compiler` must be there. */
  readonly runtime: OutputGraph;
}

/** Build-artifact scan of the server graph of a PoC build. */
export function checkServerGraph(
  graphs: ServerGraphs = {
    markers: dirGraph("dist/ssr, dist/analog/server", SERVER_DIRS),
    runtime: dirGraph("dist/analog/server", ["analog/server"]),
  },
): void {
  section(`Server graph (${graphs.markers.label})`);

  for (const marker of [...SERVER_ONLY, MARKERS.client]) {
    const found = graphFilesWith(graphs.markers, marker);

    check(`${marker} present (${found.join(", ")})`, found.length > 0, "not found");
  }

  check(
    `@angular/compiler present in ${graphs.runtime.label}`,
    graphFilesWith(graphs.runtime, ANGULAR_COMPILER_FINGERPRINT).length > 0,
  );
}

export interface ProductionServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Starts the built Nitro `node-server` output on a free port and waits for it. */
export async function startProductionServer(): Promise<ProductionServer> {
  const port = await findFreePort();
  const server = spawnManaged(process.execPath, ["dist/analog/server/index.mjs"], {
    cwd: fixtureDir,
    env: { PORT: String(port), NITRO_PORT: String(port) },
  });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHttp(`${baseUrl}/`, server, 30_000);
  } catch (error) {
    await server.stop();
    throw error;
  }

  return { baseUrl, stop: () => server.stop() };
}
