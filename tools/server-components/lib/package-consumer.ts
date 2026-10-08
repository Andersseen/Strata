import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { chromium } from "playwright";
import type { Page } from "playwright";

import { findFreePort, spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
import type { ManagedProcess } from "../../analog/lib/process.ts";
import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";

import { COMPATIBILITY_DATE } from "./wrangler.ts";

/**
 * Helpers of `pnpm test:server-component-package-consumer`
 * (docs/research/server-component-package-consumer.md): a layout-aware tarball
 * inspector for the private package, an isolated environment for the external
 * consumer, and small process/browser helpers. Private to the repo.
 */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  probe: () => T | Promise<T>,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<Exclude<T, false | 0 | "" | null | undefined> | undefined> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();

    if (value) return value as Exclude<T, false | 0 | "" | null | undefined>;
    if (Date.now() >= deadline) return undefined;

    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Isolated environment

/**
 * The environment of every consumer command: no pnpm/npm script variables, no
 * NODE_PATH/NODE_OPTIONS, and an EMPTY npm user config, so nothing from the
 * developer's machine (tokens, registries, workspace settings) leaks in.
 */
export function isolatedEnv(
  userConfig: string,
  globalConfig: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|NODE_PATH$|NODE_OPTIONS$|INIT_CWD$|NPM_TOKEN$)/i.test(key)) continue;
    env[key] = value;
  }

  env["NPM_CONFIG_USERCONFIG"] = userConfig;
  env["NPM_CONFIG_GLOBALCONFIG"] = globalConfig;

  return { ...env, ...extra };
}

// ---------------------------------------------------------------------------
// Tarball

export interface PackedManifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface Tarball {
  readonly path: string;
  readonly sizeBytes: number;
  /** Paths relative to the package root (`package/` stripped). */
  readonly files: readonly string[];
  readonly manifest: PackedManifest;
  /** Where the tarball was extracted for text scans. */
  readonly extractedDir: string;
}

export function readTarball(path: string, extractedDir: string): Tarball {
  const listing = run("tar", ["-tzf", path]);

  if (listing.status !== 0) throw new Error(`tar -t failed: ${listing.stderr}`);

  const files = listing.stdout
    .split("\n")
    .filter((entry) => entry && !entry.endsWith("/"))
    .map((entry) => entry.replace(/^package\//, ""))
    .sort();

  mkdirSync(extractedDir, { recursive: true });
  run("tar", ["-xzf", path, "-C", extractedDir, "--strip-components=1"]);

  return {
    path,
    sizeBytes: readFileSync(path).byteLength,
    files,
    manifest: JSON.parse(
      readFileSync(join(extractedDir, "package.json"), "utf8"),
    ) as PackedManifest,
    extractedDir,
  };
}

/** `[subpath, condition, target]` for every export condition except `./package.json`. */
export function exportTargets(
  manifest: PackedManifest,
): { subpath: string; condition: string; target: string }[] {
  const targets: { subpath: string; condition: string; target: string }[] = [];

  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (subpath === "./package.json") continue;

    for (const [condition, target] of Object.entries(
      typeof entry === "string" ? { default: entry } : entry,
    )) {
      targets.push({ subpath, condition, target });
    }
  }

  return targets;
}

export const FORBIDDEN_TARBALL_PATH =
  /(^|\/)(src|tools|apps|node_modules|\.git)\/|\.test\.|(^|\/)vite\.config\.|(^|\/)tsconfig[^/]*\.json$/;

export const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export interface BareImport {
  readonly file: string;
  readonly specifier: string;
}

const STATIC_IMPORT =
  /(?:^|[;}\n])\s*(?:import|export)\s*(?:[\w$*{}\s,]+?\s*)?from\s*["']([^"'\n]+)["']/g;
const SIDE_EFFECT_IMPORT = /(?:^|[;}\n])\s*import\s*["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g;

/**
 * Bare imports of the emitted JavaScript under `dir`. Specifiers inside template
 * literals (`${…}`, the generated surrogate source) and the documented
 * `@strata-sc/server-components/server-only` text emitted INTO consumer files
 * are not imports of the package itself and are reported by the caller.
 */
export function bareImports(dir: string, files: readonly string[]): BareImport[] {
  const found: BareImport[] = [];

  for (const file of files) {
    if (!file.endsWith(".js")) continue;

    const source = readFileSync(join(dir, file), "utf8");

    for (const pattern of [STATIC_IMPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]!;

        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes("${")) {
          continue;
        }

        found.push({ file, specifier });
      }
    }
  }

  return found;
}

/** Textual tarball files that mention any of `needles` (absolute local paths). */
export function filesMentioning(
  dir: string,
  files: readonly string[],
  needles: readonly string[],
): string[] {
  return files.filter((file) => {
    if (!/\.(js|ts|map|json|md)$/.test(file)) return false;

    const text = readFileSync(join(dir, file), "utf8");

    return needles.some((needle) => needle.length > 3 && text.includes(needle));
  });
}

// ---------------------------------------------------------------------------
// Installed tree

export function installedManifest(consumerDir: string, name: string): PackedManifest | undefined {
  const path = join(consumerDir, "node_modules", name, "package.json");

  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PackedManifest) : undefined;
}

export function installedVersion(consumerDir: string, name: string): string {
  return installedManifest(consumerDir, name)?.version ?? "(not installed)";
}

/** Every directory in `node_modules` (at any depth) that holds package `name`. */
export function findInstalledCopies(consumerDir: string, name: string): string[] {
  const copies: string[] = [];
  const walk = (modules: string): void => {
    if (!existsSync(modules)) return;

    const target = join(modules, name);

    if (existsSync(join(target, "package.json"))) copies.push(relative(consumerDir, target));

    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;

      if (entry.name.startsWith("@")) {
        for (const scoped of readdirSync(join(modules, entry.name), { withFileTypes: true })) {
          walk(join(modules, entry.name, scoped.name, "node_modules"));
        }
      } else {
        walk(join(modules, entry.name, "node_modules"));
      }
    }
  };

  walk(join(consumerDir, "node_modules"));

  return copies;
}

export function isSymlinkAnywhere(path: string): boolean {
  let current = path;

  while (current !== dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
    if (current.endsWith(`${sep}node_modules`)) break;
    current = dirname(current);
  }

  return false;
}

/** Whether `path` resolves under `parent` once symlinks (macOS `/tmp`) are resolved. */
export function isUnder(path: string, parent: string): boolean {
  const real = realpathSync(path.startsWith("file:") ? new URL(path) : path);
  const root = realpathSync(parent);

  return real === root || real.startsWith(root + sep);
}

/** Resolves `specifier` from the consumer, with Node's ESM resolver, in a fresh process. */
export function resolveFromConsumer(
  consumerDir: string,
  specifiers: readonly string[],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const script = join(consumerDir, ".resolve-check.mjs");

  writeFileSync(
    script,
    `const out = {};
for (const s of ${JSON.stringify(specifiers)}) out[s] = import.meta.resolve(s);
console.log(JSON.stringify(out));
`,
  );

  try {
    const result = run(process.execPath, [script], { cwd: consumerDir, env });

    if (result.status !== 0) throw new Error(`resolve check failed: ${result.stderr}`);

    return JSON.parse(result.stdout) as Record<string, string>;
  } finally {
    rmSync(script, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Source snapshot (mutation scenarios)

export type Snapshot = ReadonlyMap<string, Buffer>;

export function snapshotDir(dir: string, skip: (relativePath: string) => boolean): Snapshot {
  const files = new Map<string, Buffer>();

  for (const file of listFiles(dir)) {
    if (!skip(file)) files.set(file, readFileSync(join(dir, file)));
  }

  return files;
}

/** Puts `dir` back to exactly `snapshot`: rewrites changed files, removes extra ones. */
export function restoreDir(
  dir: string,
  snapshot: Snapshot,
  skip: (relativePath: string) => boolean,
): void {
  for (const file of listFiles(dir)) {
    if (!skip(file) && !snapshot.has(file)) rmSync(join(dir, file), { force: true });
  }

  for (const [file, bytes] of snapshot) {
    const path = join(dir, file);

    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) writeFileSync(path, bytes);
  }
}

export function snapshotDiffers(
  dir: string,
  snapshot: Snapshot,
  skip: (relativePath: string) => boolean,
): string[] {
  const now = snapshotDir(dir, skip);
  const problems: string[] = [];

  for (const [file, bytes] of snapshot) {
    if (!now.get(file)?.equals(bytes)) problems.push(file);
  }
  for (const file of now.keys()) if (!snapshot.has(file)) problems.push(`${file} (extra)`);

  return problems;
}

// ---------------------------------------------------------------------------
// Servers

export interface RunningServer {
  readonly baseUrl: string;
  output(): string;
  since(mark: number): string;
  mark(): number;
  stop(): Promise<void>;
  readonly process: ManagedProcess;
}

export async function startServer(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    port: number;
    readyPath: string;
    timeoutMs?: number;
  },
): Promise<RunningServer> {
  const server = spawnManaged(command, args, { cwd: options.cwd, env: options.env });
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const output = (): string => stripVTControlCharacters(server.output());

  try {
    await waitForHttp(`${baseUrl}${options.readyPath}`, server, options.timeoutMs ?? 90_000);
  } catch (error) {
    await server.stop();
    throw error;
  }

  return {
    baseUrl,
    output,
    mark: () => output().length,
    since: (mark) => output().slice(mark),
    stop: () => server.stop(),
    process: server,
  };
}

/** `node dist/analog/server/index.mjs` of the consumer's own production build. */
export async function startNodeServer(
  consumerDir: string,
  env: NodeJS.ProcessEnv,
): Promise<RunningServer> {
  const port = await findFreePort();

  return startServer(process.execPath, ["dist/analog/server/index.mjs"], {
    cwd: consumerDir,
    env: { ...env, PORT: String(port), NITRO_PORT: String(port) },
    port,
    readyPath: "/",
    timeoutMs: 30_000,
  });
}

/** The consumer's own `vite` binary in dev mode. */
export async function startDevServer(
  consumerDir: string,
  env: NodeJS.ProcessEnv,
): Promise<RunningServer> {
  const port = await findFreePort();

  return startServer(
    process.execPath,
    [
      join(consumerDir, "node_modules", "vite", "bin", "vite.js"),
      "--port",
      String(port),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
    { cwd: consumerDir, env, port, readyPath: "/" },
  );
}

/** `wrangler pages dev` (the CONSUMER's own wrangler) on the consumer's Cloudflare build. */
export async function startWrangler(
  consumerDir: string,
  env: NodeJS.ProcessEnv,
): Promise<RunningServer> {
  const port = await findFreePort();
  const inspectorPort = await findFreePort();
  const bin = join(consumerDir, "node_modules", "wrangler", "bin", "wrangler.js");

  return startServer(
    process.execPath,
    [
      bin,
      "pages",
      "dev",
      "dist/analog/public",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--compatibility-date",
      COMPATIBILITY_DATE,
      "--persist-to",
      "dist/.wrangler-state",
      "--log-level",
      "info",
    ],
    {
      cwd: consumerDir,
      env: {
        ...env,
        CI: "true",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(consumerDir, "dist", ".wrangler-logs"),
      },
      port,
      readyPath: "/product",
      timeoutMs: 120_000,
    },
  );
}

// ---------------------------------------------------------------------------
// Browser

export interface RequestRecord {
  readonly type: string;
  readonly url: string;
  readonly navigation: boolean;
}

export interface Tracked {
  readonly page: Page;
  readonly errors: string[];
  readonly requests: RequestRecord[];
  close(): Promise<void>;
}

export async function openTracked(): Promise<Tracked> {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  const requests: RequestRecord[] = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    requests.push({
      type: request.resourceType(),
      url: request.url(),
      navigation: request.isNavigationRequest(),
    });
  });

  return { page, errors, requests, close: () => browser.close() };
}

/** `evaluate` of a source string: the tools' tsconfig has no DOM lib. */
export function evaluate<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(expression);
}
