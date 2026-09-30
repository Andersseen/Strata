import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { findFreePort, httpGet, spawnManaged, waitForHttp } from "../analog/lib/process.ts";
import type { ManagedProcess } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";

import {
  ANGULAR_COMPILER_FINGERPRINT,
  check,
  checkNoBuildTools,
  dirGraph,
  finish as finishRun,
  graphFilesWith,
  repoRoot,
  section,
} from "./lib/harness.ts";
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

const TITLE = "www Server Component dogfood";
const stop = (): never => finishRun(TITLE);

const wwwDir = join(repoRoot, "apps", "www");
const distDir = join(wwwDir, "dist");

const MARKERS = {
  component: "STRATA_WWW_SERVER_COMPONENT_MARKER",
  repository: "STRATA_WWW_SERVER_REPOSITORY_MARKER",
  transitive: "STRATA_WWW_TRANSITIVE_SERVER_MARKER",
  client: "STRATA_WWW_CLIENT_ISLAND_MARKER",
} as const;
const SERVER_ONLY = [MARKERS.component, MARKERS.repository, MARKERS.transitive] as const;

/** Source modules, as bundler source-map paths end, that must never reach the browser. */
const SERVER_MODULES = [
  "src/app/server-components/server-components-showcase.component.ts",
  "src/app/server-components/server-component-facts.repository.ts",
  "src/app/server-components/server-component-proof.ts",
  "packages/server-components/dist/vite.js",
] as const;
/** Source modules the browser graph needs: the island and the generated surrogate. */
const CLIENT_MODULES = [
  "src/app/server-components/server-component-demo.component.ts",
  "src/generated/server-components/server-components/server-components-showcase.component.ts",
] as const;
const SERVER_FILE_NAMES = ["showcase", "facts", "repository", "proof"];

/** Rendered by the Server Component only; each must be in the HTML before any JS runs. */
const SSR_EXPECTATIONS = [
  ["Server Component host", "<strata-server-components-showcase"],
  ["section heading", "Angular components that stay on the server."],
  ["repository data (module graph)", "ServerComponentFactsRepository"],
  ["repository data (runtime)", "Angular + Analog"],
  ["preview status", "The public package is not released yet."],
  ["router limitation", "is not supported yet"],
  ["client island initial state", "Interactions: 0"],
] as const;

const WORKER_DIR = "analog/public/_worker.js";
const WORKER_ENTRY = "index.js";

function build(label: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void {
  rmSync(distDir, { recursive: true, force: true });

  const result = run("pnpm", ["exec", "vite", "build", ...args], {
    cwd: wwwDir,
    env: { ...process.env, ...env },
  });

  check(`${label}: production build exits 0`, result.status === 0, result.stderr.slice(-2_000));
  if (result.status !== 0) stop();
}

const all = (results: readonly boolean[]): boolean => results.every(Boolean);
const jsFiles = (graph: OutputGraph): OutputGraph => ({
  ...graph,
  label: `${graph.label} (.js)`,
  files: graph.files.filter((file) => /\.m?js$/.test(file)),
});

/** Every source module bundled into the graph's JavaScript, from its source maps. */
function bundledSources(graph: OutputGraph): string[] {
  return graph.files
    .filter((file) => file.endsWith(".js.map") || file.endsWith(".mjs.map"))
    .flatMap(
      (file) =>
        (JSON.parse(readFileSync(join(distDir, file), "utf8")) as { sources?: string[] }).sources ??
        [],
    );
}

function checkBrowserGraph(graph: OutputGraph, sourceMaps: boolean): boolean {
  section(`Browser graph (${graph.label})`);

  const js = jsFiles(graph);
  const results = [
    ...SERVER_ONLY.map((marker) => {
      const found = graphFilesWith(graph, marker);

      return check(`${marker} absent`, found.length === 0, found.join(", "));
    }),
    (() => {
      const found = graphFilesWith(js, MARKERS.client);

      return check(
        `${MARKERS.client} present in browser JS (${found.join(", ")})`,
        found.length > 0,
        "not found",
      );
    })(),
    (() => {
      const leaked = graph.files.filter((file) =>
        SERVER_FILE_NAMES.some((name) => file.toLowerCase().includes(name)),
      );

      return check(
        "no browser file is named after a server-only module",
        leaked.length === 0,
        leaked.join(", "),
      );
    })(),
    check(
      "@angular/compiler absent from the browser output",
      graphFilesWith(graph, ANGULAR_COMPILER_FINGERPRINT).length === 0,
    ),
  ];

  checkNoBuildTools(graph);

  if (sourceMaps) {
    const sources = bundledSources(graph);

    console.log(`browser chunks bundle ${sources.length} source modules`);
    results.push(check("browser source maps list the bundled modules", sources.length > 0));

    for (const module of SERVER_MODULES) {
      const found = sources.filter((source) => source.endsWith(module));

      results.push(check(`module ${module} not bundled for the browser`, found.length === 0));
    }

    for (const module of CLIENT_MODULES) {
      results.push(
        check(
          `module ${module} bundled for the browser`,
          sources.some((source) => source.endsWith(module)),
        ),
      );
    }
  }

  return all(results);
}

function checkServerGraph(graph: OutputGraph): boolean {
  section(`Server graph (${graph.label})`);

  return all(
    [...SERVER_ONLY, MARKERS.client].map((marker) => {
      const found = graphFilesWith(graph, marker);

      return check(`${marker} present (${found.join(", ")})`, found.length > 0, "not found");
    }),
  );
}

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

/** Runs the site's own Playwright suite against `baseUrl`, output streamed. */
async function runPlaywright(baseUrl: string, runtime: string): Promise<boolean> {
  section(`${runtime}: Playwright (apps/www/e2e) — hydration, interaction, Angular errors`);

  const status = await new Promise<number>((resolve) => {
    const child = spawn("pnpm", ["exec", "playwright", "test", "--reporter=list"], {
      cwd: wwwDir,
      env: { ...process.env, STRATA_WWW_BASE_URL: baseUrl },
      stdio: "inherit",
    });

    child.on("exit", (code) => resolve(code ?? 1));
  });

  return check(`${runtime}: Playwright suite passes`, status === 0, `exit ${status}`);
}

async function withServer(
  server: ManagedProcess,
  baseUrl: string,
  runtime: string,
  timeoutMs: number,
): Promise<{ ssr: boolean; e2e: boolean }> {
  try {
    await waitForHttp(`${baseUrl}/`, server, timeoutMs);

    const ssr = await checkSsr(baseUrl, runtime);
    const e2e = await runPlaywright(baseUrl, runtime);

    return { ssr, e2e };
  } catch (error) {
    check(`${runtime} starts`, false, `${String(error)}\n${server.output().slice(-2_000)}`);

    return { ssr: false, e2e: false };
  } finally {
    await server.stop();
  }
}

const verdict: Record<string, boolean> = {};

// 0. Control: with the plugin off the site is plain SSR, and every server-only
// marker and module must then reach the browser; otherwise the scans below
// would prove nothing.
section("Control build: plain SSR (STRATA_SERVER_COMPONENTS=off)");
build("control", ["--sourcemap", "hidden"], { STRATA_SERVER_COMPONENTS: "off" });

{
  const browser = dirGraph("dist/client", ["client"], () => false, distDir);
  const sources = bundledSources(browser);

  verdict["control leaks (scanner sees server code)"] = all([
    ...SERVER_ONLY.map((marker) =>
      check(
        `control leaks ${marker} into browser JS`,
        graphFilesWith(jsFiles(browser), marker).length > 0,
      ),
    ),
    ...SERVER_MODULES.slice(0, 3).map((module) =>
      check(
        `control bundles ${module} for the browser`,
        sources.some((source) => source.endsWith(module)),
      ),
    ),
  ]);
}

// 1–3. Node build. Hidden source maps leave every emitted .js byte-identical
// (no sourceMappingURL comment) and add the per-chunk module list.
section("Node build: vite build --sourcemap hidden");
build("Node", ["--sourcemap", "hidden"]);

verdict["node browser graph"] = checkBrowserGraph(
  dirGraph("dist/client, dist/analog/public", ["client", "analog/public"], () => false, distDir),
  true,
);
verdict["node server graph"] = checkServerGraph(
  dirGraph("dist/ssr, dist/analog/server", ["ssr", "analog/server"], () => false, distDir),
);

{
  const ssrSources = bundledSources(dirGraph("dist/ssr", ["ssr"], () => false, distDir));

  verdict["node server modules"] = all(
    SERVER_MODULES.slice(0, 3).map((module) =>
      check(
        `module ${module} bundled for SSR`,
        ssrSources.some((source) => source.endsWith(module)),
      ),
    ),
  );
}

// 4–5. Nitro node-server.
{
  const port = await findFreePort();
  const server = spawnManaged(process.execPath, ["dist/analog/server/index.mjs"], {
    cwd: wwwDir,
    env: { PORT: String(port), NITRO_PORT: String(port) },
  });
  const result = await withServer(server, `http://127.0.0.1:${port}`, "Nitro node-server", 30_000);

  verdict["node SSR"] = result.ssr;
  verdict["node hydration + interaction (Playwright)"] = result.e2e;
}

// 6. Cloudflare Pages build: the deploy command's own build, no source maps.
section("Cloudflare build: BUILD_PRESET=cloudflare-pages (the deploy build)");
build("Cloudflare", [], { BUILD_PRESET: "cloudflare-pages" });

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
  if (!verdict["cloudflare preset"]) stop();

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

  verdict["cloudflare Worker graph"] = checkServerGraph(workerGraph);
  verdict["cloudflare browser assets"] = checkBrowserGraph(
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
  const result = await withServer(
    server,
    `http://127.0.0.1:${port}`,
    "Wrangler Pages (workerd)",
    60_000,
  );

  verdict["workerd SSR"] = result.ssr;
  verdict["workerd hydration + interaction (Playwright)"] = result.e2e;
}

section("Verdict");

for (const [name, passed] of Object.entries(verdict)) {
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}`);
}

stop();
