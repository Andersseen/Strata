import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findFreePort, httpGet, spawnManaged } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";

import { all, createAppGate } from "./lib/app-gate.ts";
import { check, repoRoot, section } from "./lib/harness.ts";
import type { OutputGraph } from "./lib/harness.ts";
import { isNodeBuiltin, moduleGraph } from "./lib/module-graph.ts";
import { resolveWrangler } from "./lib/wrangler.ts";

/**
 * `pnpm test:www:server-components`: the official website dogfoods the
 * private @strata-sc/server-components package on its real homepage. This
 * gate proves the site has the property it sells, on both deploy targets:
 *
 *   0. control build, plugin off: server-only code MUST leak
 *   1. Node build (hidden source maps: same JS, plus a module list per chunk)
 *   2. browser graph: no server-only marker, no server-only module in any
 *      chunk's sources, no build tooling; the client island is there
 *   3. server graph: the Server Component, its repository and the
 *      repository's transitive import are all there
 *   4. Nitro node-server: HTTP SSR of `/` (prerendered) and of a runtime-SSR
 *      path, i.e. the HTML before any browser JavaScript
 *   5. the site's Playwright suite against that server: hydration of the one
 *      island, interaction, no Angular hydration errors
 *   6. Cloudflare Pages build (exactly the deploy command): Worker graph vs
 *      static assets
 *   7. Wrangler's local Pages runtime (workerd): SSR, then the same
 *      Playwright suite
 */

const MARKERS = {
  component: "STRATA_WWW_SERVER_COMPONENT_MARKER",
  repository: "STRATA_WWW_SERVER_REPOSITORY_MARKER",
  transitive: "STRATA_WWW_TRANSITIVE_SERVER_MARKER",
  client: "STRATA_WWW_CLIENT_ISLAND_MARKER",
} as const;
const SERVER_ONLY = [MARKERS.component, MARKERS.repository, MARKERS.transitive];

const wwwDir = join(repoRoot, "apps", "www");
const gate = createAppGate({
  title: "www Server Component dogfood",
  appDir: wwwDir,
  baseUrlEnv: "STRATA_WWW_BASE_URL",
  serverOnlyMarkers: SERVER_ONLY,
  clientMarkers: [MARKERS.client],
  serverModules: [
    "src/app/server-components/server-components-showcase.component.ts",
    "src/app/server-components/server-component-facts.repository.ts",
    "src/app/server-components/server-component-proof.ts",
  ],
  serverOnlyAssertions: [
    "src/app/server-components/server-component-facts.repository.ts",
    "src/app/server-components/server-component-proof.ts",
  ],
  clientModules: [
    "src/app/server-components/server-component-demo.component.ts",
    "src/generated/server-components/server-components/server-components-showcase.component.ts",
  ],
  serverFileNames: ["showcase", "facts", "repository", "proof"],
});
const { distDir, verdict } = gate;

/** Rendered by the Server Component only; each must be in the HTML before any JS runs. */
const SSR_EXPECTATIONS = [
  ["Server Component host", "<strata-server-components-showcase"],
  ["section heading", "Angular components that stay on the server."],
  ["repository data (module graph)", "ServerComponentFactsRepository"],
  ["repository data (runtime)", "Angular + Analog"],
  ["experimental status", "the API may change before 1.0"],
  ["router limitation", "is not supported yet"],
  ["client island initial state", "Interactions: 0"],
] as const;

const WORKER_DIR = "analog/public/_worker.js";
const WORKER_ENTRY = "index.js";

async function checkSsr(baseUrl: string, runtime: string): Promise<boolean> {
  const results: boolean[] = [];

  // `/` is prerendered at build time; any other path is rendered on request,
  // so both the build-time and the runtime server graph render the section.
  for (const [route, kind] of [
    ["/", "prerendered"],
    ["/__strata-www-runtime-ssr", "runtime SSR"],
  ] as const) {
    section(`${runtime}: GET ${route} (${kind}), HTML before any browser JavaScript`);

    const response = await httpGet(`${baseUrl}${route}`);
    const html = response.body;
    const island = html.match(/<strata-server-demo[^>]*>/)?.[0] ?? "";
    const props = island.match(/data-strata-props="([^"]*)"/)?.[1]?.replaceAll("&quot;", '"');

    results.push(
      check(
        "HTTP 200 text/html",
        response.status === 200 && !!response.contentType?.includes("text/html"),
        `${response.status} ${response.contentType}`,
      ),
      ...SSR_EXPECTATIONS.map(([label, text]) => check(`SSR HTML: ${label}`, html.includes(text))),
      check(
        "island boundary is annotated for hydration (data-strata-client + ngh)",
        /data-strata-client="strata-server-demo"/.test(island) && /\sngh="\d+"/.test(island),
        island || "no <strata-server-demo>",
      ),
      check(
        "server-computed props crossed as flat plain data",
        props ===
          JSON.stringify({
            label: "Run interaction",
            componentId: "ServerComponentsShowcase",
            serverOnlyModules: 3,
          }),
        String(props),
      ),
      check(
        "SSR HTML carries no server-only marker (only data crosses)",
        SERVER_ONLY.every((marker) => !html.includes(marker)),
      ),
    );
  }

  return all(results);
}

// 0–5. Control, Node build and graphs, Nitro node-server.
gate.control();
gate.nodeBuild();
await gate.nodeServer(checkSsr);

// 6. Cloudflare Pages build: the deploy command's own build, no source maps.
section("Cloudflare build: BUILD_PRESET=cloudflare-pages (the deploy build)");
gate.build("Cloudflare", [], { BUILD_PRESET: "cloudflare-pages" });

{
  // The site's Cloudflare config points Nitro's output dir at the upload dir.
  const meta = JSON.parse(
    readFileSync(join(distDir, "analog", "public", "nitro.json"), "utf8"),
  ) as {
    preset?: string;
  };
  const entry = join(distDir, WORKER_DIR, WORKER_ENTRY);

  verdict["cloudflare preset"] = all([
    check(
      "resolved Nitro preset is cloudflare-pages",
      meta.preset === "cloudflare-pages",
      String(meta.preset),
    ),
    check(`Worker entry ${WORKER_DIR}/${WORKER_ENTRY} exists`, existsSync(entry)),
  ]);
  if (!verdict["cloudflare preset"]) gate.stop();

  const graph = moduleGraph(join(distDir, WORKER_DIR), WORKER_ENTRY);
  const workerGraph: OutputGraph = {
    label: `Worker graph reachable from ${WORKER_DIR}/${WORKER_ENTRY}`,
    root: distDir,
    files: graph.modules.map((module) => `${WORKER_DIR}/${module}`),
  };
  const builtins = [
    ...new Set(graph.externals.filter((e) => isNodeBuiltin(e.specifier)).map((e) => e.specifier)),
  ];

  console.log(`reachable Worker modules: ${graph.modules.length}`);
  console.log(
    `Node built-ins the Worker imports (the site enables nodejs_compat): ${builtins.join(", ") || "(none)"}`,
  );

  verdict["cloudflare Worker graph"] = gate.checkServerGraph(workerGraph);
  verdict["cloudflare browser assets"] = gate.checkBrowserGraph(
    {
      label: "dist/client, dist/analog/public without _worker.js",
      root: distDir,
      files: [
        ...listFiles(join(distDir, "client")).map((file) => `client/${file}`),
        ...listFiles(join(distDir, "analog", "public"))
          .map((file) => `analog/public/${file}`)
          .filter((file) => !file.startsWith(`${WORKER_DIR}/`)),
      ],
    },
    false,
  );
}

// 7. Wrangler's local Pages runtime, from apps/www so its wrangler.jsonc
// (compatibility date, nodejs_compat) applies exactly as on deploy.
{
  const wrangler = resolveWrangler();
  const port = await findFreePort();
  const inspectorPort = await findFreePort();

  console.log(`\nwrangler: ${wrangler.reported} (pinned ${wrangler.pinned})`);

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
      "--persist-to",
      "dist/.wrangler-state",
      "--log-level",
      "warn",
    ],
    {
      cwd: wwwDir,
      env: {
        CI: "true",
        NO_COLOR: "1",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(distDir, ".wrangler-logs"),
      },
    },
  );
  const result = await gate.withServer(
    server,
    `http://127.0.0.1:${port}`,
    "Wrangler Pages (workerd)",
    60_000,
    checkSsr,
  );

  verdict["workerd SSR"] = result.ssr;
  verdict["workerd hydration + interaction (Playwright)"] = result.e2e;
}

gate.report();
