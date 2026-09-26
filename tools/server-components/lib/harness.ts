import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findFreePort, spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
import { findFilesContaining, listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";

/**
 * Shared, private harness of the server-component PoC commands
 * (`pnpm test:server-components`, `pnpm test:server-component-navigation`):
 * the check log, the fixture's production build, the graph scans and the
 * production Nitro server. Not a package, not public API.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");

export const fixtureDir = join(repoRoot, "apps", "analog-fixture");
export const distDir = join(fixtureDir, "dist");

export const MARKERS = {
  implementation: "STRATA_SERVER_COMPONENT_IMPLEMENTATION_MARKER",
  repository: "STRATA_SERVER_COMPONENT_REPOSITORY_MARKER",
  transitive: "STRATA_TRANSITIVE_SERVER_ONLY_MARKER",
  client: "STRATA_CLIENT_COMPONENT_MARKER",
  control: "STRATA_ANALOG_CLIENT_CONTROL_MARKER",
} as const;
export const SERVER_ONLY = [
  MARKERS.implementation,
  MARKERS.repository,
  MARKERS.transitive,
] as const;
/** A string only `@angular/compiler` contains: the compiler must stay server-side. */
const ANGULAR_COMPILER_FINGERPRINT = "Unterminated quote";
/** Module names that would reveal server-only source layout in a browser file name. */
const SERVER_FILE_NAMES = ["product-details", "product-repository", "server-secret"];

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

/** Production build of the fixture; ends the run (via `onFailure`) if it fails. */
export function build(label: string, env: NodeJS.ProcessEnv, onFailure: () => never): void {
  rmSync(distDir, { recursive: true, force: true });

  const result = run("pnpm", ["exec", "vite", "build"], {
    cwd: fixtureDir,
    env: { ...process.env, ...env },
  });

  check(`${label}: production build exits 0`, result.status === 0, result.stderr.slice(-2_000));
  if (result.status !== 0) onFailure();
}

/** Files under the given dist subdirectories that contain `needle`. */
export function filesWith(dirs: readonly string[], needle: string): string[] {
  return dirs.flatMap((dir) =>
    findFilesContaining(join(distDir, dir), needle).map((f) => `${dir}/${f}`),
  );
}

/** Build-artifact scan of the browser graph of a PoC build. */
export function checkBrowserGraph(): void {
  section("Browser graph (dist/client, dist/analog/public)");

  for (const marker of SERVER_ONLY) {
    const found = filesWith(BROWSER_DIRS, marker);

    check(`${marker} absent`, found.length === 0, found.join(", "));
  }

  for (const marker of [MARKERS.client, MARKERS.control]) {
    const found = filesWith(BROWSER_DIRS, marker);

    check(`${marker} present (${found.join(", ")})`, found.length > 0, "not found");
  }

  const browserFiles = BROWSER_DIRS.flatMap((dir) => listFiles(join(distDir, dir)));
  const leakedNames = browserFiles.filter((file) =>
    SERVER_FILE_NAMES.some((name) => file.includes(name)),
  );
  const compilerInBrowser = filesWith(BROWSER_DIRS, ANGULAR_COMPILER_FINGERPRINT);

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
  console.log(`browser files scanned (incl. maps/manifests if any): ${browserFiles.join(", ")}`);
}

/** Build-artifact scan of the server graph of a PoC build. */
export function checkServerGraph(): void {
  section("Server graph (dist/ssr, dist/analog/server)");

  for (const marker of [...SERVER_ONLY, MARKERS.client]) {
    const found = filesWith(SERVER_DIRS, marker);

    check(`${marker} present (${found.join(", ")})`, found.length > 0, "not found");
  }

  check(
    "@angular/compiler present in the Nitro server output",
    filesWith(["analog/server"], ANGULAR_COMPILER_FINGERPRINT).length > 0,
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
