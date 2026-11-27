import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
import type { ManagedProcess } from "../../analog/lib/process.ts";
import { run } from "../../consumer/lib/exec.ts";

import { fixtureDir, repoRoot } from "./harness.ts";

/**
 * Wrangler's local Pages runtime (workerd) for the Cloudflare qualification of
 * the server-component PoC. Wrangler is not a dependency of the fixture or the
 * root: the one pinned copy is `@strata-sc/www`'s, resolved from that package
 * so this run and the website's deploy always use the same version.
 */

const wwwManifestPath = join(repoRoot, "apps", "www", "package.json");

/**
 * The website's `wrangler.jsonc` date, so both run on the same workerd
 * semantics. `nodejs_compat` is deliberately NOT enabled: the fixture's Worker
 * must run without Node built-ins, which is the stricter qualification.
 */
export const COMPATIBILITY_DATE = "2026-09-21";

export interface WranglerInfo {
  /** Version pinned in `apps/www/package.json`. */
  readonly pinned: string;
  /** Version the resolved binary reports. */
  readonly reported: string;
  readonly bin: string;
}

export function resolveWrangler(): WranglerInfo {
  const www = JSON.parse(readFileSync(wwwManifestPath, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const manifestPath = createRequire(wwwManifestPath).resolve("wrangler/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: Record<string, string>;
  };
  const bin = join(dirname(manifestPath), manifest.bin["wrangler"]!);
  const version = run(process.execPath, [bin, "--version"], { cwd: fixtureDir });

  return {
    pinned: www.devDependencies?.["wrangler"] ?? "(not pinned)",
    reported: version.stdout.trim(),
    bin,
  };
}

export interface WranglerPages {
  readonly baseUrl: string;
  /** Wrangler's and workerd's console output so far (request log, Worker errors). */
  output(): string;
  stop(): Promise<void>;
}

export interface PagesDevOptions {
  /** The Wrangler entry script: a consumer's own installed copy, or the pinned one. */
  readonly bin: string;
  readonly cwd: string;
  /** First answered path; startup is only complete when this path gets any HTTP response. */
  readonly readyPath: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Omitted: the project's own `wrangler.jsonc` decides, as on deploy. */
  readonly compatibilityDate?: string;
  /** Default 120 s. */
  readonly timeoutMs?: number;
}

export interface PagesDevServer extends WranglerPages {
  readonly process: ManagedProcess;
}

/**
 * The port in Wrangler's `Ready on` line. Wrangler prints a `[wrangler:info]` banner once the proxy
 * listens, at `--log-level info` or lower; `--port 0` would otherwise leave no way to reach it.
 */
export function announcedPort(output: string): number | null {
  const match = /Ready on https?:\/\/[^\s:/]+:(\d+)/.exec(output);
  const port = match ? Number(match[1]) : 0;

  return port > 0 ? port : null;
}

/** Every socket of the run bound by the kernel: see {@link startPagesDev}. */
export function pagesDevArgs(bin: string, compatibilityDate?: string): string[] {
  return [
    bin,
    "pages",
    "dev",
    "dist/analog/public",
    "--ip",
    "127.0.0.1",
    "--port",
    "0",
    "--inspector-port",
    "0",
    ...(compatibilityDate ? ["--compatibility-date", compatibilityDate] : []),
    "--persist-to",
    "dist/.wrangler-state",
    "--log-level",
    "info",
  ];
}

/**
 * `wrangler pages dev dist/analog/public`, the one way the tools start local workerd.
 *
 * The HTTP and inspector sockets bind port 0 and the real port is read back from Wrangler. Choosing
 * numbers here cannot be made safe: they would come from the kernel's ephemeral pool, be released,
 * and stay unbound for the seconds Wrangler needs to start, while Wrangler itself opens about ten
 * sockets on port 0 out of that same pool. A hit kills workerd with `bind(): Address already in
 * use` (CI 42210806375), and the message does not say which socket lost.
 *
 * There is no retry: without a chosen number there is no collision to recover from, and any other
 * startup failure is a real one. A failed start stops the whole process group before rejecting.
 */
export async function startPagesDev(options: PagesDevOptions): Promise<PagesDevServer> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const server = spawnManaged(
    process.execPath,
    pagesDevArgs(options.bin, options.compatibilityDate),
    {
      cwd: options.cwd,
      env: {
        ...options.env,
        CI: "true",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(options.cwd, "dist", ".wrangler-logs"),
      },
    },
  );

  try {
    let port = announcedPort(server.output());

    while (port === null) {
      if (server.hasExited())
        throw new Error(`Wrangler exited during startup:\n${server.output()}`);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Wrangler to announce a port:\n${server.output()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      port = announcedPort(server.output());
    }

    const baseUrl = `http://127.0.0.1:${port}`;

    await waitForHttp(`${baseUrl}${options.readyPath}`, server, deadline - Date.now());

    return { baseUrl, output: () => server.output(), stop: () => server.stop(), process: server };
  } catch (error) {
    await server.stop();
    throw error;
  }
}

/** The fixture's `wrangler pages dev`, waited for. */
export function startWranglerPages(wrangler: WranglerInfo): Promise<WranglerPages> {
  return startPagesDev({
    bin: wrangler.bin,
    cwd: fixtureDir,
    readyPath: "/api/native",
    compatibilityDate: COMPATIBILITY_DATE,
    timeoutMs: 60_000,
  });
}
