import {
  build,
  check,
  finish,
  fixtureDir,
  section,
  startProductionServer,
} from "../server-components/lib/harness.ts";
import {
  resolveWrangler,
  startWranglerPages,
  COMPATIBILITY_DATE,
} from "../server-components/lib/wrangler.ts";

import { observeForms } from "./lib/forms.ts";
import { findFreePort, spawnManaged, waitForHttp } from "./lib/process.ts";
import type { Runtime } from "./lib/streaming.ts";

/** Real Analog/Nitro qualification for readValidatedForm() on Node, dev and local workerd. */
const TITLE = "Analog validated URL-encoded forms qualification";
const selected = (process.env["STRATA_FORMS_RUNTIMES"] ?? "node,dev,workerd").split(",");
const wants = (runtime: Runtime): boolean => selected.includes(runtime);

if (wants("node")) {
  section("Node production server");
  build("Node", { BUILD_PRESET: undefined }, () => finish(TITLE));
  const server = await startProductionServer();
  try {
    await observeForms(server.baseUrl, "node", check, () => server.output());
  } finally {
    await server.stop();
  }
}

if (wants("dev")) {
  section("Vite dev server");
  const port = await findFreePort();
  const server = spawnManaged("pnpm", ["exec", "vite", "--port", String(port), "--strictPort"], {
    cwd: fixtureDir,
    env: {},
  });
  try {
    await waitForHttp(`http://localhost:${port}/api/native`, server, 90_000);
    await observeForms(`http://localhost:${port}`, "dev", check, () => server.output());
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
    await observeForms(server.baseUrl, "workerd", check, () => server.output());
  } finally {
    await server.stop();
  }
}

finish(TITLE);
