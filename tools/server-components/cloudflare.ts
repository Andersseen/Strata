import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";

import { checkDirectLoad } from "./lib/direct-load.ts";
import {
  ANGULAR_COMPILER_FINGERPRINT,
  BROWSER_DIRS,
  MARKERS,
  SERVER_ONLY,
  build,
  check,
  checkBrowserGraph,
  checkServerGraph,
  dirGraph,
  distDir,
  finish,
  graphFilesWith,
  measure,
  section,
} from "./lib/harness.ts";
import type { GraphSize, OutputGraph } from "./lib/harness.ts";
import { isNodeBuiltin, moduleGraph } from "./lib/module-graph.ts";
import { DESTINATION, ORIGIN, observeNavigation } from "./lib/navigation.ts";
import type { DomSnapshot } from "./lib/navigation.ts";
import { COMPATIBILITY_DATE, resolveWrangler, startWranglerPages } from "./lib/wrangler.ts";

/**
 * `pnpm test:server-components:cloudflare`: the server-component PoC on
 * Cloudflare's runtime (docs/research/server-component-cloudflare-poc.md).
 * Same fixture, same server component, same client boundary; only the Nitro
 * preset changes (`BUILD_PRESET=cloudflare-pages`, Analog's documented path),
 * and the server is Wrangler's local Pages runtime (workerd), not Node.
 *
 *   1. Node baseline build (default preset stays `node-server`), sizes
 *   2. Cloudflare build: resolved preset, output structure, Worker entry,
 *      reachable Worker module graph, Node built-in imports
 *   3. browser-graph and Worker-graph marker scans, sizes vs Node
 *   4. `wrangler pages dev`: native Analog route, `@strata-sc/analog`
 *      controllers, the SPEC-003 Angular DI route (characterized)
 *   5. direct load: HTTP SSR, hydration by DOM identity, interaction
 *   6. document navigation; Angular Router navigation stays NO-GO
 *
 * The Angular DI assertions pin the measured workerd limitation (no JIT code
 * generation); they fail if that behaviour changes.
 */

const TITLE = "server-component Cloudflare qualification";
const stop = (): never => finish(TITLE);

const WORKER_DIR = "analog/public/_worker.js";
const WORKER_ENTRY = "index.js";
/** workerd's message when code asks to compile a string (`eval`, `new Function`). */
const CODE_GENERATION_DISALLOWED = "Code generation from strings disallowed for this context";

const all = (results: readonly boolean[]): boolean => results.every(Boolean);
const describe = (snapshot: DomSnapshot): string => JSON.stringify(snapshot);

interface NitroMeta {
  readonly preset?: string;
  readonly versions?: { readonly nitro?: string };
  readonly commands?: Record<string, string>;
}

function readNitroMeta(): NitroMeta | null {
  const path = join(distDir, "analog", "nitro.json");

  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as NitroMeta) : null;
}

/** `dist/` down to `depth`, one line per entry, directories marked with `/`. */
function tree(dir: string, depth: number, indent = ""): string[] {
  return readdirSync(join(distDir, dir), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      const line = `${indent}${entry.name}${entry.isDirectory() ? "/" : ""}`;

      if (!entry.isDirectory()) return [line];
      if (depth <= 1) return [`${line} (${listFiles(join(distDir, path)).length} files)`];

      return [line, ...tree(path, depth - 1, `${indent}  `)];
    });
}

function sizeRow(output: string, runtime: string, size: GraphSize): string {
  return `| ${output} | ${runtime} | ${size.jsFiles} | ${size.jsBytes} | ${size.jsGzipBytes} | ${size.allFiles} | ${size.allBytes} |`;
}

const verdict = {
  preset: false,
  workerGraph: false,
  browserGraph: false,
  boots: false,
  native: false,
  controllers: false,
  angularDi: "not run",
  directSsr: false,
  hydration: false,
  interaction: false,
  documentNavigation: false,
  routerNegative: false,
};

// 1. Node baseline: the fixture's default preset must still be `node-server`.
section("Node baseline build (default preset)");
build("Node baseline", { BUILD_PRESET: undefined }, stop);

const nodeMeta = readNitroMeta();

check(
  "default build resolves Nitro preset node-server",
  nodeMeta?.preset === "node-server",
  String(nodeMeta?.preset),
);

const nodeSizes = {
  browser: measure(dirGraph("browser", BROWSER_DIRS)),
  server: measure(
    dirGraph("server", ["analog/server"], (file) => file.startsWith("analog/server/node_modules/")),
  ),
  serverWithTraced: measure(dirGraph("server", ["analog/server"])),
};

// 2. Cloudflare build.
section("Cloudflare build: BUILD_PRESET=cloudflare-pages");

const log = build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop);
const meta = readNitroMeta();

console.log(
  `build log (Nitro lines): ${log.match(/^.*(?:Generated|Building Server|Prerender).*$/gm)?.join(" | ") ?? "(none)"}`,
);
verdict.preset = all([
  check(
    "dist/analog/nitro.json: resolved preset is cloudflare-pages (not node-server)",
    meta?.preset === "cloudflare-pages",
    String(meta?.preset),
  ),
  check(
    "build log shows the Pages routing files Nitro's cloudflare-pages preset writes",
    /Generated dist\/analog\/_routes\.json/.test(log),
  ),
  check(
    `Worker entry ${WORKER_DIR}/${WORKER_ENTRY} exists`,
    existsSync(join(distDir, WORKER_DIR, WORKER_ENTRY)),
  ),
  check(
    "no node-server output (dist/analog/server) left",
    !existsSync(join(distDir, "analog/server")),
  ),
]);
console.log(`nitro: ${meta?.versions?.nitro}, preset commands: ${JSON.stringify(meta?.commands)}`);
console.log(`output structure:\n  ${tree("analog", 3).join("\n  ")}`);

if (!verdict.preset) stop();

const entrySource = readFileSync(join(distDir, WORKER_DIR, WORKER_ENTRY), "utf8");
const graph = moduleGraph(join(distDir, WORKER_DIR), WORKER_ENTRY);
const workerFiles = listFiles(join(distDir, WORKER_DIR));
const unreachable = workerFiles.filter(
  (file) => !file.endsWith(".map") && !graph.modules.includes(file),
);
const builtins = graph.externals.filter((external) => isNodeBuiltin(external.specifier));
const workerGraph: OutputGraph = {
  label: `Worker graph reachable from ${WORKER_DIR}/${WORKER_ENTRY}`,
  files: graph.modules.map((module) => `${WORKER_DIR}/${module}`),
};

console.log(`worker entry: ${entrySource.replace(/\n\/\/# sourceMappingURL.*$/s, "")}`);
console.log(`reachable Worker modules (${graph.modules.length}): ${graph.modules.join(", ")}`);
console.log(
  `unreachable files in ${WORKER_DIR} (${unreachable.length}; attached by Wrangler, never imported): ${unreachable.join(", ")}`,
);

// Scanner control: the prerender entry Nitro leaves beside the Worker is a
// Node module. If the scan below cannot see its `node:*` imports, a clean
// result for the real Worker would prove nothing.
if (unreachable.includes("index.mjs")) {
  const control = moduleGraph(join(distDir, WORKER_DIR), "index.mjs").externals.filter(
    (external) => external.importer === "index.mjs" && isNodeBuiltin(external.specifier),
  );

  check(
    `scanner control: the unreachable prerender entry index.mjs is flagged (${control.map((e) => e.specifier).join(", ")})`,
    control.length > 0,
    "no Node built-in found",
  );
}

verdict.workerGraph = all([
  check(
    "the entry default-exports the Nitro Worker (module format)",
    /export\s*\{[^}]*\bas default\b[^}]*\}\s*from/.test(entrySource),
  ),
  check(
    "the reachable Worker graph imports nothing outside itself",
    graph.externals.length === 0,
    graph.externals.map((e) => `${e.specifier} (${e.importer})`).join(", "),
  ),
  check(
    "no Node built-in import (node:fs, node:path, node:child_process, …) in the Worker graph",
    builtins.length === 0,
    builtins.map((e) => `${e.specifier} (${e.importer})`).join(", "),
  ),
]);

// What is left of Node in the executed Worker: unenv shims Nitro substituted.
const workerSource = workerGraph.files
  .map((file) => readFileSync(join(distDir, file), "utf8"))
  .join("\n");
const shims = [...new Set(workerSource.match(/notImplemented\("[\w.:]+/g) ?? [])].map((m) =>
  m.slice('notImplemented("'.length),
);

console.log(
  `unenv not-implemented shims in the Worker graph (${shims.length}): ${shims.join(", ")}`,
);
console.log(
  `identifier counts in the Worker graph — Buffer: ${workerSource.match(/\bBuffer\b/g)?.length ?? 0}, ` +
    `process.env: ${workerSource.match(/process\.env/g)?.length ?? 0}, ` +
    `require(: ${workerSource.match(/\brequire\(/g)?.length ?? 0}, ` +
    `new Function: ${workerSource.match(/new Function\b/g)?.length ?? 0}`,
);

// 3. Graph scans. The Worker lives inside the Pages output directory, so the
// browser graph is that directory minus `_worker.js/` (Pages never serves it;
// checked over HTTP below), plus Vite's client build.
const browserGraph = dirGraph(
  `dist/client, dist/analog/public minus ${WORKER_DIR}/`,
  BROWSER_DIRS,
  (file) => file.startsWith(`${WORKER_DIR}/`),
);

checkBrowserGraph(browserGraph);
checkServerGraph({ markers: workerGraph, runtime: workerGraph });

section("Transitive negative control: ProductRepository → server-secret.ts");

const secretInWorker = graphFilesWith(workerGraph, MARKERS.transitive);
const secretInBrowser = graphFilesWith(browserGraph, MARKERS.transitive);

check(
  `${MARKERS.transitive} in the Worker graph ✓ (${secretInWorker.join(", ")})`,
  secretInWorker.length > 0,
);
check(`${MARKERS.transitive} in the browser graph ✗`, secretInBrowser.length === 0);
verdict.browserGraph = all([
  SERVER_ONLY.every((marker) => graphFilesWith(browserGraph, marker).length === 0),
  graphFilesWith(browserGraph, MARKERS.client).length > 0,
]);
verdict.workerGraph &&= all([
  SERVER_ONLY.every((marker) => graphFilesWith(workerGraph, marker).length > 0),
]);

section("Bundle size: Node (node-server) vs Cloudflare (cloudflare-pages)");

const cfSizes = { browser: measure(browserGraph), worker: measure(workerGraph) };

console.log("| Output | Runtime | JS files | JS bytes | JS gzip | All files | All bytes |");
console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
console.log(sizeRow("browser", "Node", nodeSizes.browser));
console.log(sizeRow("browser", "Cloudflare", cfSizes.browser));
console.log(sizeRow("server chunks (dist/analog/server, own)", "Node", nodeSizes.server));
console.log(sizeRow("server incl. traced node_modules", "Node", nodeSizes.serverWithTraced));
console.log(sizeRow("Worker (reachable graph)", "Cloudflare", cfSizes.worker));
console.log(
  `@angular/compiler in the Worker graph: ${graphFilesWith(workerGraph, ANGULAR_COMPILER_FINGERPRINT).join(", ") || "absent"}; in the browser graph: ${graphFilesWith(browserGraph, ANGULAR_COMPILER_FINGERPRINT).join(", ") || "absent"}`,
);

// 4. Wrangler's local Pages runtime.
section("Wrangler Pages local runtime");

const wrangler = resolveWrangler();

console.log(
  `wrangler: pinned ${wrangler.pinned} in @strata-sc/www, binary reports ${wrangler.reported}; compatibility date ${COMPATIBILITY_DATE}; no compatibility flags`,
);
check(
  "the resolved Wrangler is the single version pinned by @strata-sc/www",
  wrangler.reported === wrangler.pinned,
  `${wrangler.reported} ≠ ${wrangler.pinned}`,
);

const server = await startWranglerPages(wrangler).catch((error: unknown) => {
  check("wrangler pages dev boots and answers", false, String(error).slice(0, 2_000));

  return stop();
});

verdict.boots = check("wrangler pages dev boots and answers", true);

try {
  const { baseUrl } = server;
  const getJson = async (path: string) => {
    const response = await httpGet(`${baseUrl}${path}`);

    return {
      ...response,
      json: response.contentType?.includes("json") ? (JSON.parse(response.body) as unknown) : null,
    };
  };

  section("Native Analog route");

  const native = await getJson("/api/native");

  verdict.native = check(
    'GET /api/native → 200 {"source":"analog"}',
    native.status === 200 && JSON.stringify(native.json) === '{"source":"analog"}',
    `${native.status} ${native.body}`,
  );

  section("@strata-sc/analog controllers on Nitro's router");

  const users = await getJson("/api/strata/users");
  const user = await getJson("/api/strata/users/42");
  const greetings = [await getJson("/api/strata/greeting"), await getJson("/api/strata/greeting")];

  verdict.controllers = all([
    check(
      "GET /api/strata/users → 200 [{id:1, Ada}]",
      users.status === 200 && JSON.stringify(users.json) === '[{"id":"1","name":"Ada"}]',
      `${users.status} ${users.body}`,
    ),
    check(
      "GET /api/strata/users/42 (dynamic route) → 200 {id:42}",
      user.status === 200 && JSON.stringify(user.json) === '{"id":"42","name":"Ada"}',
      `${user.status} ${user.body}`,
    ),
    check(
      "GET /api/strata/greeting twice: controllerFactory builds a new instance per request",
      greetings.every(
        (g) => g.status === 200 && JSON.stringify(g.json) === '{"greeting":"hello","calls":1}',
      ),
      greetings.map((g) => `${g.status} ${g.body}`).join(" | "),
    ),
  ]);

  section("Angular DI experiment (SPEC-003) under workerd (characterization)");

  const statsBefore = await getJson("/api/strata-angular-di-stats");
  const logBefore = server.output().length;
  const di = await getJson("/api/strata/angular-di/products/a");
  const statsAfter = await getJson("/api/strata-angular-di-stats");

  // workerd's error report can reach Wrangler's output after the response.
  for (
    let waited = 0;
    waited < 5_000 && !server.output().slice(logBefore).includes("EvalError");
    waited += 100
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const diLog = server.output().slice(logBefore);
  const jitBlocked =
    diLog.includes(`EvalError: ${CODE_GENERATION_DISALLOWED}`) &&
    diLog.includes("JitEvaluator") &&
    diLog.includes("compileFactory");

  console.log(`GET /api/strata/angular-di/products/a → ${di.status}`);
  console.log(`stats before: ${statsBefore.body}`);
  console.log(`stats after:  ${statsAfter.body}`);
  console.log(
    `Worker error: ${diLog.match(/EvalError: [^\n]*/)?.[0] ?? "(none)"}; frames: ${[
      ...diLog.matchAll(/at ([\w.]+(?: \[as \w+\])?) \(/g),
    ]
      .map((m) => m[1])
      .slice(0, 8)
      .join(" ← ")}`,
  );

  if (di.status === 200) {
    verdict.angularDi =
      "UNEXPECTED: the request succeeded — the recorded JIT blocker no longer reproduces";
    check("Angular DI route reproduces the recorded JIT blocker", false, di.body);
  } else {
    verdict.angularDi = all([
      check("the route fails with 500", di.status === 500, String(di.status)),
      check(
        "cause: workerd refuses Angular's JIT code generation (EvalError from JitEvaluator while compiling an @Injectable factory)",
        jitBlocked,
        diLog.slice(0, 2_000),
      ),
      check(
        "the failure is contained: no request injector left alive, Worker keeps serving",
        statsAfter.status === 200 &&
          (statsAfter.json as { injectorsAlive?: number } | null)?.injectorsAlive === 0,
        statsAfter.body,
      ),
    ])
      ? "NO-GO (Angular JIT restriction: no code generation from strings in workerd)"
      : "UNEXPECTED: differs from the recorded failure";
  }

  section("Worker files are not served as static assets");

  const serverChunk = graph.modules.find((module) => module.includes("server-component.page"));

  for (const path of [`/_worker.js/${WORKER_ENTRY}`, `/_worker.js/${serverChunk}`]) {
    const response = await httpGet(`${baseUrl}${path}`);

    check(
      `GET ${path} → ${response.status} ${response.contentType} (${response.body.includes("<app-root") ? "rendered by the app, not the file" : "not the file"}), no Worker source or server-only marker`,
      !response.body.includes("nitro.mjs") &&
        SERVER_ONLY.every((marker) => !response.body.includes(marker)),
      response.body.slice(0, 200),
    );
  }

  // 5. Direct load.
  const direct = await checkDirectLoad(baseUrl, DESTINATION, "Wrangler Pages");

  verdict.directSsr = direct.ssr && direct.runtimeGraph;
  verdict.hydration = direct.hydration;
  verdict.interaction = direct.interaction;

  // 6. Navigation.
  const seen = await observeNavigation(baseUrl);
  const doc = seen.document;
  const router = seen.router;

  section(`Document navigation: ${ORIGIN} → <a href="${DESTINATION}">`);

  const nav = doc.afterNavigation;
  const docHtml = doc.session.documents.get(DESTINATION) ?? "";

  console.log(`after navigation: ${describe(nav)}`);
  verdict.documentNavigation = all([
    check(
      "a new document request reached the Worker",
      doc.session.requests.some(
        (r) =>
          r.phase === "document navigation" &&
          r.navigation &&
          r.resourceType === "document" &&
          r.url === DESTINATION,
      ),
    ),
    check("new JavaScript realm (sentinel gone)", !nav.sentinel),
    check(
      "document HTML carries the server data (Product 42, Server rendered product, Count: 0)",
      docHtml.includes("<h1>Product 42</h1>") &&
        docHtml.includes("<p>Server rendered product</p>") &&
        docHtml.includes("Count: 0"),
    ),
    check(
      "document HTML carries no server-only marker",
      SERVER_ONLY.every((marker) => !docHtml.includes(marker)),
    ),
    check("child boundary hydrates", doc.islandHydrated),
    check(
      "one island, no [ngh] left",
      nav.islandsCreated === 1 &&
        nav.hydratedIslands === 1 &&
        nav.remainingHydrationAnnotations === 0,
      describe(nav),
    ),
    check(
      "Count: 0 → click → Count: 1",
      nav.count === "Count: 0" && doc.countAfterClick === "Count: 1",
    ),
    check(
      "re-entry: new realm, one island, one increment per click (Count: 1, Count: 2)",
      doc.reentryHydrated &&
        !doc.reentry.sentinel &&
        doc.reentry.islandsCreated === 1 &&
        doc.reentryCounts.join(",") === "Count: 1,Count: 2",
      `${describe(doc.reentry)} ${doc.reentryCounts.join(" → ")}`,
    ),
    check(
      "no console errors, warnings or page errors",
      doc.session.errors.length === 0,
      doc.session.errors.join(" | "),
    ),
  ]);

  section(
    `Angular Router navigation: routerLink="${DESTINATION}" (regression of the recorded NO-GO)`,
  );

  const spa = router.afterNavigation;
  const routerRequests = router.session.requests.filter((r) => r.phase === "router navigation");

  console.log(`after: ${describe(spa)}`);
  verdict.routerNegative = all([
    check("same JavaScript realm (sentinel kept)", spa.sentinel && spa.url === DESTINATION),
    check(
      "no document request, no server payload",
      routerRequests.every(
        (r) => !r.navigation && r.resourceType !== "document" && !r.carriedServerHtml,
      ),
    ),
    check(
      "empty surrogate: host rendered, no article, no Product 42, no island",
      spa.serverComponentHosts === 1 &&
        spa.serverComponentChildren === 0 &&
        !spa.productText &&
        spa.addToCartHosts === 0 &&
        spa.islandsCreated === 0,
      describe(spa),
    ),
  ]);

  section("Worker runtime errors");

  const workerErrors = (server.output().match(/\[ERROR\][^\n]*/g) ?? []).filter(
    (line) => !line.includes("/api/strata/angular-di/"),
  );

  check(
    "no Worker error other than the characterized Angular DI request",
    workerErrors.length === 0,
    workerErrors.join(" | "),
  );
} finally {
  await server.stop();
}

section("Classification (as measured)");

const mark = (ok: boolean) => (ok ? "✓" : "✗");

console.log(`cloudflare-pages preset confirmed     ${mark(verdict.preset)}`);
console.log(`Worker graph (entry, no Node imports) ${mark(verdict.workerGraph)}`);
console.log(`browser graph (server-only absent)    ${mark(verdict.browserGraph)}`);
console.log(`Wrangler runtime boots                ${mark(verdict.boots)}`);
console.log(`Analog basic runtime                  ${verdict.native ? "GO" : "NO-GO"}`);
console.log(`@strata-sc/analog controllers         ${verdict.controllers ? "GO" : "NO-GO"}`);
console.log(`Angular DI experiment                 ${verdict.angularDi}`);
console.log(
  `Server Component direct load          ${verdict.directSsr && verdict.hydration && verdict.interaction && verdict.browserGraph && verdict.workerGraph ? "GO" : "NO-GO"}`,
);
console.log(`Server Component document navigation ${verdict.documentNavigation ? "GO" : "NO-GO"}`);
console.log(
  `Angular Router navigation             ${verdict.routerNegative ? "NO-GO (limitation reproduced, unchanged by the runtime)" : "UNEXPECTED: differs from the recorded limitation"}`,
);

stop();
