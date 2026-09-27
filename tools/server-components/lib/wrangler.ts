import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { findFreePort, spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
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

/** `wrangler pages dev dist/analog/public` on a free port, waited for. */
export async function startWranglerPages(wrangler: WranglerInfo): Promise<WranglerPages> {
  const port = await findFreePort();
  const inspectorPort = await findFreePort();
  const server = spawnManaged(
    process.execPath,
    [
      wrangler.bin,
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
      cwd: fixtureDir,
      env: {
        CI: "true",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(fixtureDir, "dist", ".wrangler-logs"),
      },
    },
  );
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHttp(`${baseUrl}/api/native`, server, 60_000);
  } catch (error) {
    await server.stop();
    throw error;
  }

  return { baseUrl, output: () => server.output(), stop: () => server.stop() };
}
