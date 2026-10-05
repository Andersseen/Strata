import { httpGet } from "../analog/lib/process.ts";

import {
  BROWSER_DIRS,
  MARKERS,
  SERVER_DIRS,
  build,
  check,
  dirGraph,
  finish,
  section,
  startProductionServer,
} from "./lib/harness.ts";
import {
  checkServerOnlyControl,
  checkServerOnlyFailsClosed,
  checkServerOnlyGraphs,
} from "./lib/server-only.ts";

/**
 * `pnpm test:server-component-server-only`: the server-only assertion
 * (`import "@strata-sc/server-components/server-only"`) as a build-graph
 * firewall, against the Analog fixture's production builds on Nitro
 * `node-server`:
 *
 *   1. control build, plugin off: the canary and the marked modules MUST
 *      reach the browser, or the scans below prove nothing
 *   2. production build with hidden source maps: marked modules and the
 *      canary in the server graph only, the assertion entry absent from the
 *      browser, the shared module in both graphs
 *   3. Nitro node-server: the Server Component renders through the marked
 *      repository; the canary is not in the HTML
 *   4. fail closed: direct, dynamic, barrel, chained barrel, `?raw`, `?url`
 *      and `@defer`-lazy browser imports each fail a real production build
 *
 * The Worker graph (workerd) is covered by `pnpm test:server-components:cloudflare`,
 * which scans the same canary in the Worker and the public assets.
 */

const TITLE = "Server-only modules: build-graph firewall";
const stop = (): never => finish(TITLE);
const verdict: Record<string, boolean> = {};

section("Control build: plain SSR (STRATA_SERVER_COMPONENTS=off), hidden source maps");
build("control", { STRATA_SERVER_COMPONENTS: "off" }, stop, ["--sourcemap", "hidden"]);
verdict["control: scans see the server-only modules"] = checkServerOnlyControl();

section("Production build: hidden source maps");
build("production", {}, stop, ["--sourcemap", "hidden"]);
verdict["Node build: server graph ✓, browser graph ✗"] = checkServerOnlyGraphs(
  dirGraph("dist/client, dist/analog/public", BROWSER_DIRS),
  dirGraph("dist/ssr, dist/analog/server", SERVER_DIRS),
);

const server = await startProductionServer();

try {
  section("Nitro node-server: GET /server-component");

  const response = await httpGet(`${server.baseUrl}/server-component`);

  verdict["Node SSR through the server-only repository"] = [
    check("HTTP 200", response.status === 200, String(response.status)),
    check(
      "the Server Component rendered the repository's product",
      response.body.includes("<h1>Product 42</h1>"),
    ),
    check(
      `${MARKERS.serverOnlyCanary} not in the HTML (only a runtime hash crosses)`,
      !response.body.includes(MARKERS.serverOnlyCanary),
    ),
  ].every(Boolean);
} finally {
  await server.stop();
}

verdict["illegal browser imports fail the build"] = checkServerOnlyFailsClosed();

section("Verdict");

for (const [name, passed] of Object.entries(verdict)) {
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}`);
}

stop();
