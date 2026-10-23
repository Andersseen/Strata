import { join } from "node:path";

import {
  BROWSER_DIRS,
  build,
  check,
  distDir,
  finish,
  fixtureDir,
  section,
  startProductionServer,
} from "../server-components/lib/harness.ts";
import {
  COMPATIBILITY_DATE,
  resolveWrangler,
  startWranglerPages,
} from "../server-components/lib/wrangler.ts";

import { findFreePort, spawnManaged, waitForHttp } from "./lib/process.ts";
import {
  SERVER_FN_CANARY,
  STREAM_CANARY,
  filesContaining,
  observeServerFunctions,
  observeStreaming,
} from "./lib/streaming.ts";
import type { Runtime } from "./lib/streaming.ts";

/**
 * `pnpm test:analog-streaming`: the HTTP streaming lifecycle of
 * `@strata-sc/analog` and a real Analog server function, observed on the real
 * fixture (docs/research/analog-stream-lifecycle-v07.md).
 *
 *   1. Node production server (Nitro `node-server`)
 *   2. Vite dev server (Analog development mode)
 *   3. Wrangler Pages local runtime (workerd), preset `cloudflare-pages`
 *
 * `STRATA_STREAMING_RUNTIMES=node,dev,workerd` selects a subset.
 */

const TITLE = "Analog streaming lifecycle and serverFn qualification";
const selected = (process.env["STRATA_STREAMING_RUNTIMES"] ?? "node,dev,workerd").split(",");
const wants = (runtime: Runtime): boolean => selected.includes(runtime);

const observations: Record<string, unknown> = {};

async function observe(baseUrl: string, runtime: Runtime, output: () => string): Promise<void> {
  const streaming = await observeStreaming(baseUrl, runtime, check);
  const serverFns = await observeServerFunctions(baseUrl, runtime, check, output);

  observations[runtime] = { ...streaming, serverFn: serverFns.status };
  console.log(
    `${runtime}: transport ${streaming.transport}; native failure -> ${streaming.nativeFailure}; ` +
      `strata failure -> ${streaming.strataFailure}; client disconnect -> ${streaming.disconnect}`,
  );
  console.log(`${runtime}: serverFn statuses ${JSON.stringify(serverFns.status)}`);
  if (Object.values(serverFns.status).some((value) => value >= 500)) {
    const errors = output()
      .split("\n")
      .filter((line) => /error/i.test(line))
      .slice(0, 6)
      .map((line) => line.trim().slice(0, 300));

    console.log(`${runtime}: serverFn failure output: ${errors.join(" / ")}`);
  }
  check(
    `${runtime}: the process output holds no unhandled rejection`,
    !/UnhandledPromiseRejection|unhandled promise rejection/i.test(output()),
  );
}

/** The Pages Worker lives inside `analog/public`; Pages never serves `_worker.js/`. */
const notWorker = (file: string): boolean => !file.startsWith("_worker.js/");

function checkBrowserOutput(runtime: string): void {
  const dirs = BROWSER_DIRS.map((dir) => join(distDir, dir));
  for (const canary of [STREAM_CANARY, SERVER_FN_CANARY]) {
    const leaks = dirs.flatMap((dir) => filesContaining(dir, canary)).filter(notWorker);
    check(
      `${runtime}: ${canary} is absent from the browser output`,
      leaks.length === 0,
      leaks.join(", "),
    );
  }
  const handlers = dirs
    .flatMap((dir) => filesContaining(dir, "registerControllers"))
    .filter(notWorker);
  check(
    `${runtime}: no Strata adapter code in the browser output`,
    handlers.length === 0,
    handlers.join(", "),
  );
}

if (wants("node")) {
  section("Node production server");
  build("Node", { BUILD_PRESET: undefined }, () => finish(TITLE));
  checkBrowserOutput("node");

  const server = await startProductionServer();

  try {
    await observe(server.baseUrl, "node", () => server.output());
  } finally {
    await server.stop();
  }
}

if (wants("dev")) {
  section("Vite dev server (Analog development mode)");

  const port = await findFreePort();
  const server = spawnManaged("pnpm", ["exec", "vite", "--port", String(port), "--strictPort"], {
    cwd: fixtureDir,
    env: {},
  });
  const baseUrl = `http://localhost:${port}`;

  try {
    await waitForHttp(`${baseUrl}/api/native`, server, 90_000);
    await observe(baseUrl, "dev", () => server.output());
  } finally {
    await server.stop();
  }
}

if (wants("workerd")) {
  section("Local Cloudflare Pages runtime (workerd)");
  build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, () => finish(TITLE));
  checkBrowserOutput("workerd");

  const wrangler = resolveWrangler();

  console.log(`wrangler ${wrangler.reported}, compatibility date ${COMPATIBILITY_DATE}`);

  const server = await startWranglerPages(wrangler);

  try {
    await observe(server.baseUrl, "workerd", () => server.output());
  } finally {
    await server.stop();
  }
}

console.log(`\nobservations: ${JSON.stringify(observations)}`);
finish(TITLE);
