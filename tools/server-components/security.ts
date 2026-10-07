import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listFiles } from "../analog/lib/scan.ts";

import {
  BROWSER_DIRS,
  SERVER_DIRS,
  build,
  check,
  dirGraph,
  distDir,
  finish,
  fixtureDir,
  graphFilesWith,
  section,
  startProductionServer,
} from "./lib/harness.ts";
import {
  DATA_SECRET_CANARY,
  captureResponse,
  expectGraphAbsent,
  expectGraphPresent,
  extensionCounts,
  scannerSelfTest,
  expectAbsent,
  expectResponseAbsent,
} from "./lib/leak-scan.ts";
import { moduleGraph } from "./lib/module-graph.ts";
import {
  SECURITY_MODULES,
  SECURITY_ROUTE,
  checkBuildDiagnosticConfidentiality,
  checkCrossRequest,
  checkCrossings,
  checkSecretErrors,
  checkSecurityBrowser,
  checkSecurityHttp,
  openBrowser,
  printFrameworkTuple,
} from "./lib/security.ts";
import type { RuntimeTarget } from "./lib/security.ts";
import { bundledSources, declaresServerOnly } from "./lib/server-only.ts";
import { resolveWrangler, startWranglerPages } from "./lib/wrangler.ts";

/**
 * `pnpm test:server-component-security`: Server Component DATA
 * confidentiality (docs/research/server-component-data-security.md), against
 * the Analog fixture's `/server-component-security*` routes.
 *
 *   A server-owned value does not cross into browser-visible output merely
 *   because a Server Component reads or uses it. What a developer passes on
 *   purpose through `[strataClient]` is public browser data.
 *
 * Graph isolation (`pnpm test:server-component-server-only`) is necessary and
 * not sufficient: a module that stays on the server can still leak a value
 * through HTML, boundary props, hydration state, errors or source maps. This
 * gate scans those surfaces for two synthetic canaries (lib/leak-scan.ts):
 * a DATA secret that must appear nowhere public and a PUBLIC control that must
 * appear everywhere it deliberately crosses, so a clean scan cannot be a blind one.
 *
 *   1. resolved framework tuple
 *   2. control build, plugin off: the DATA canary MUST reach the browser
 *   3. Node production build: server graph ✓, browser artifacts and source maps ✗
 *   4. Nitro node-server: raw SSR HTML, headers, boundary payload, hydrated DOM,
 *      browser network, unsupported values, secret-bearing errors, overlapping requests
 *   5. consumption control: the secret changes what the server renders
 *   6. build diagnostics of an illegal import carry no secret
 *   7. workerd (Wrangler Pages): the same surfaces on the Worker runtime
 */

const TITLE = "Server Component data confidentiality";
const stop = (): never => finish(TITLE);
const verdict: Record<string, boolean | string> = {};

const all = (results: readonly boolean[]): boolean => results.every(Boolean);

const SERVER_MODULES = [SECURITY_MODULES.secret, SECURITY_MODULES.repository];
const bundles = (sources: readonly string[], module: string): boolean =>
  sources.some((source) => source.endsWith(module));

printFrameworkTuple();

section("Scanner self-test");
verdict["scanner self-test: every claimed encoding is detected"] = scannerSelfTest();

// 2. Control: with the plugin off the same fixture ships the repository to the browser.
section("Control build: plain SSR (STRATA_SERVER_COMPONENTS=off), hidden source maps");
build("control", { STRATA_SERVER_COMPONENTS: "off" }, stop, ["--sourcemap", "hidden"]);

{
  const browser = dirGraph("dist/client, dist/analog/public", BROWSER_DIRS);
  const sources = bundledSources(browser);

  verdict["control: the scanner sees the DATA canary when protection is off"] = all([
    expectGraphPresent(DATA_SECRET_CANARY, browser),
    ...SERVER_MODULES.map((module) =>
      check(`control bundles ${module} for the browser`, bundles(sources, module)),
    ),
  ]);
}

// 3. Production build.
section("Production build (Nitro node-server): hidden source maps");
build("production", {}, stop, ["--sourcemap", "hidden"]);

{
  const browser = dirGraph("dist/client, dist/analog/public", BROWSER_DIRS);
  const server = dirGraph("dist/ssr, dist/analog/server", SERVER_DIRS);
  const browserSources = bundledSources(browser);
  const serverSources = bundledSources(server);
  const counts = extensionCounts(browser);

  section("Server graph and browser artifacts");
  console.log(`browser files by extension: ${JSON.stringify(counts)}`);
  console.log(
    `source maps list ${browserSources.length} browser modules and ${serverSources.length} server modules`,
  );

  verdict["Node server graph: the DATA canary is in the server output"] = all([
    expectGraphPresent(DATA_SECRET_CANARY, server),
    ...SERVER_MODULES.map((module) =>
      check(`${module} bundled for the server (SSR source maps)`, bundles(serverSources, module)),
    ),
    ...SERVER_MODULES.map((module) =>
      check(
        `${module} declares import "@strata-sc/server-components/server-only" (AST)`,
        declaresServerOnly(join(fixtureDir, module)),
      ),
    ),
  ]);

  verdict["Node browser artifacts: no DATA canary in any file"] = all([
    check(
      "the scan covers .js, .html and .map files (and every other extension present)",
      [".js", ".html", ".map"].every((extension) => (counts[extension] ?? 0) > 0),
      JSON.stringify(counts),
    ),
    expectGraphAbsent(DATA_SECRET_CANARY, browser),
  ]);

  verdict["Node browser source maps: neither the canary nor the secret modules"] = all([
    check("browser source maps list the bundled modules", browserSources.length > 0),
    ...SERVER_MODULES.map((module) =>
      check(`${module} is in no browser source map`, !bundles(browserSources, module)),
    ),
    ...["readInternalCredential", "EXPECTED_CREDENTIAL_DIGEST", "failInternally"].map((source) =>
      check(
        `no browser file carries the secret modules' source ("${source}")`,
        graphFilesWith(browser, source).length === 0,
        graphFilesWith(browser, source).join(", "),
      ),
    ),
  ]);
}

// 4. Nitro node-server.
const nitro = await startProductionServer();
const nodeTarget: RuntimeTarget = {
  name: "Nitro node-server",
  baseUrl: nitro.baseUrl,
  output: () => nitro.output(),
};

try {
  const browser = await openBrowser();

  try {
    const http = await checkSecurityHttp(nodeTarget);
    const page = await checkSecurityBrowser(nodeTarget, browser);
    const errors = await checkSecretErrors(nodeTarget, browser);

    verdict["Node SSR raw HTML"] = http.ssrHtml;
    verdict["Node response headers"] = http.headers;
    verdict["Node boundary payload"] = http.payload;
    verdict["Node hydrated DOM and interaction"] = page.hydratedDom;
    verdict["Node browser network"] = page.network;
    verdict["Node PUBLIC control reaches every deliberate surface"] = page.control;
    verdict["Node unsupported values rejected before serialization"] =
      await checkCrossings(nodeTarget);
    verdict["Node secret-bearing errors: public responses"] = errors.responses;
    verdict["Node secret-bearing errors: browser surface"] = errors.browser;
    verdict["Node overlapping requests"] = await checkCrossRequest(nodeTarget);
  } finally {
    await browser.close();
  }

  section("Server log (operator surface, characterized apart from the public responses)");

  const log = nitro.output();

  console.log(
    `server log: ${log.length} chars; thrown errors logged ${(log.match(/^ERROR /gm) ?? []).length}; ` +
      `${DATA_SECRET_CANARY.label} in log: ${log.includes(DATA_SECRET_CANARY.value) ? "yes (operator only)" : "no"}`,
  );
} finally {
  await nitro.stop();
}

// 5. Consumption control: the credential is used on the server, not merely present.
section("Consumption control: altering the credential in the server output changes the render");

{
  const altered = `${DATA_SECRET_CANARY.value.slice(0, -1)}0`;
  const serverFiles = listFiles(join(distDir, "analog/server")).filter((file) =>
    /\.m?js$/.test(file),
  );
  let patched = 0;

  for (const file of serverFiles) {
    const path = join(distDir, "analog/server", file);
    const source = readFileSync(path, "utf8");

    if (source.includes(DATA_SECRET_CANARY.value)) {
      writeFileSync(path, source.replaceAll(DATA_SECRET_CANARY.value, altered));
      patched++;
    }
  }

  const control = await startProductionServer();

  try {
    const response = await captureResponse(`${control.baseUrl}${SECURITY_ROUTE}`);

    console.log(`patched ${patched} server file(s); altered credential ${altered}`);
    verdict["the DATA secret is consumed by server-side logic"] = all([
      check("the server output carried the canary in at least one file", patched > 0),
      check(
        "with the credential altered the repository's check fails: Internal verification: not ready",
        response.body.includes("Internal verification: not ready") &&
          !response.body.includes("Internal verification: ready"),
        response.body.match(/Internal verification: [a-z ]+/)?.[0],
      ),
      expectResponseAbsent("altered-credential render", DATA_SECRET_CANARY, response),
      expectAbsent(
        "altered-credential render (altered value)",
        { ...DATA_SECRET_CANARY, value: altered },
        response.body,
      ),
    ]);
  } finally {
    await control.stop();
  }
}

// 6. Build diagnostics.
verdict["build diagnostics of an illegal import carry no secret"] =
  checkBuildDiagnosticConfidentiality();

// 7. workerd.
section("Cloudflare build: BUILD_PRESET=cloudflare-pages, hidden source maps");
build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop, ["--sourcemap", "hidden"]);

{
  const WORKER_DIR = "analog/public/_worker.js";
  const graph = moduleGraph(join(distDir, WORKER_DIR), "index.js");
  const workerGraph = {
    label: `Worker graph reachable from ${WORKER_DIR}/index.js`,
    files: graph.modules.map((module) => `${WORKER_DIR}/${module}`),
  };
  const publicGraph = dirGraph(
    `dist/client, dist/analog/public minus ${WORKER_DIR}/`,
    BROWSER_DIRS,
    (file) => file.startsWith(`${WORKER_DIR}/`),
  );
  const publicSources = bundledSources(publicGraph);

  section("Worker graph and public assets");
  console.log(`public files by extension: ${JSON.stringify(extensionCounts(publicGraph))}`);

  verdict["Worker graph: the DATA canary is in the Worker"] = all([
    check("the Worker entry exists", existsSync(join(distDir, WORKER_DIR, "index.js"))),
    expectGraphPresent(DATA_SECRET_CANARY, workerGraph),
  ]);
  verdict["public assets: no DATA canary"] = all([
    expectGraphAbsent(DATA_SECRET_CANARY, publicGraph),
    ...SERVER_MODULES.map((module) =>
      check(`${module} is in no public source map`, !bundles(publicSources, module)),
    ),
  ]);

  const wrangler = resolveWrangler();
  const pages = await startWranglerPages(wrangler).catch((error: unknown) => {
    check("wrangler pages dev boots and answers", false, String(error).slice(0, 2_000));

    return stop();
  });
  const workerTarget: RuntimeTarget = {
    name: "Wrangler Pages (workerd)",
    baseUrl: pages.baseUrl,
    output: () => pages.output(),
  };

  try {
    const browser = await openBrowser();

    try {
      const http = await checkSecurityHttp(workerTarget);
      const page = await checkSecurityBrowser(workerTarget, browser);
      const errors = await checkSecretErrors(workerTarget, browser);

      verdict["workerd SSR raw HTML"] = http.ssrHtml;
      verdict["workerd response headers"] = http.headers;
      verdict["workerd boundary payload"] = http.payload;
      verdict["workerd hydrated DOM and interaction"] = page.hydratedDom;
      verdict["workerd browser network"] = page.network;
      verdict["workerd PUBLIC control reaches every deliberate surface"] = page.control;
      verdict["workerd unsupported values rejected before serialization"] =
        await checkCrossings(workerTarget);
      verdict["workerd secret-bearing errors: public responses"] = errors.responses;
      verdict["workerd secret-bearing errors: browser surface"] = errors.browser;
      verdict["workerd overlapping requests"] = await checkCrossRequest(workerTarget);
    } finally {
      await browser.close();
    }

    section("workerd: Worker files are not served as public assets");

    const workerChunks = graphFilesWith(workerGraph, DATA_SECRET_CANARY.value).map((file) =>
      file.slice("analog/public/".length),
    );
    const served = await Promise.all(
      workerChunks.map(async (path) => ({
        path,
        response: await captureResponse(`${pages.baseUrl}/${path}`),
      })),
    );

    console.log(`Worker chunks carrying the canary: ${workerChunks.join(", ")}`);
    verdict["workerd does not serve the Worker's secret-bearing files"] = all([
      check("the Worker has at least one secret-bearing chunk to probe", served.length > 0),
      ...served.map(({ path, response }) =>
        expectResponseAbsent(
          `GET /${path} (${response.status} ${response.contentType})`,
          DATA_SECRET_CANARY,
          response,
        ),
      ),
    ]);

    section("workerd: log (operator surface, characterized apart from the public responses)");

    const log = pages.output();

    console.log(
      `Wrangler/workerd log: ${log.length} chars; ${DATA_SECRET_CANARY.label} in log: ${log.includes(DATA_SECRET_CANARY.value) ? "yes (operator only)" : "no"}`,
    );
  } finally {
    await pages.stop();
  }
}

section("Verdict");

for (const [name, passed] of Object.entries(verdict)) {
  console.log(`${passed === true ? "  ok  " : " FAIL "} ${name}`);
}

if (!Object.values(verdict).every((passed) => passed === true)) {
  check("every verdict line above holds", false);
}

stop();
