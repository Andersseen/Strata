import {
  build,
  finish,
  check,
  section,
  startProductionServer,
  fixtureDir,
} from "../server-components/lib/harness.ts";
import {
  COMPATIBILITY_DATE,
  resolveWrangler,
  startWranglerPages,
} from "../server-components/lib/wrangler.ts";

import { observeCorrelation } from "./lib/correlation.ts";
import { findFreePort, spawnManaged, waitForHttp } from "./lib/process.ts";
import { observeServerFunctions } from "./lib/streaming.ts";
import type { Runtime } from "./lib/streaming.ts";

/**
 * `pnpm test:analog-correlation`: `requestCorrelation` of `@strata-sc/analog`
 * on the real fixture (docs/research/analog-request-correlation-v012.md).
 *
 *   1. Node production server (Nitro `node-server`)
 *   2. Vite dev server (Analog development mode)
 *   3. Wrangler Pages local runtime (workerd), preset `cloudflare-pages`
 *
 * `STRATA_CORRELATION_RUNTIMES=node,dev,workerd` selects a subset.
 */

const TITLE = "Analog request correlation qualification";
const selected = (process.env["STRATA_CORRELATION_RUNTIMES"] ?? "node,dev,workerd").split(",");
const wants = (runtime: Runtime): boolean => selected.includes(runtime);

const results: Record<string, unknown> = {};

async function observe(baseUrl: string, runtime: Runtime, output: () => string): Promise<void> {
  const observed = await observeCorrelation(baseUrl, runtime, check);
  const serverFns = await observeServerFunctions(baseUrl, runtime, check, output);

  results[runtime] = { outcomes: observed.outcomes, serverFn: serverFns.status };
  console.log(`${runtime}: outcomes ${observed.outcomes.join(", ")}`);
  console.log(`${runtime}: serverFn statuses ${JSON.stringify(serverFns.status)}`);
  check(
    `${runtime}: the process output holds no unhandled rejection`,
    !/UnhandledPromiseRejection|unhandled promise rejection/i.test(output()),
  );
}

if (wants("node")) {
  section("Node production server");
  build("Node", { BUILD_PRESET: undefined }, () => finish(TITLE));

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

  const wrangler = resolveWrangler();

  console.log(`wrangler ${wrangler.reported}, compatibility date ${COMPATIBILITY_DATE}`);

  const server = await startWranglerPages(wrangler);

  try {
    await observe(server.baseUrl, "workerd", () => server.output());
  } finally {
    await server.stop();
  }
}

console.log(`\nobservations: ${JSON.stringify(results)}`);
finish(TITLE);
