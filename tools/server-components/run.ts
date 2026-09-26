import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";

import { observeBrowser } from "./lib/browser.ts";
import {
  BROWSER_DIRS,
  MARKERS,
  SERVER_ONLY,
  build as buildFixture,
  check,
  checkBrowserGraph,
  checkServerGraph,
  distDir,
  filesWith,
  finish as finishRun,
  section,
  startProductionServer,
} from "./lib/harness.ts";

/**
 * `pnpm test:server-components`: the server-component graph PoC
 * (docs/research/server-component-graph-poc.md), end to end against the
 * Analog fixture's production build.
 *
 *   1. control build: plugin off, i.e. plain SSR; server markers MUST leak
 *   2. PoC build
 *   3. browser-graph and server-graph marker scans, bundle sizes
 *   4. production server: direct HTTP SSR assertion
 *   5. Chromium: hydration by DOM identity, then interaction
 */

const ROUTE = "/server-component";

function finish(): never {
  finishRun("server-component graph PoC");
}

function build(label: string, env: NodeJS.ProcessEnv): void {
  buildFixture(label, env, finish);
}

interface GraphSize {
  readonly jsFiles: number;
  readonly jsBytes: number;
  readonly jsGzipBytes: number;
  readonly allFiles: number;
  readonly allBytes: number;
}

function measure(dir: string): GraphSize {
  const root = join(distDir, dir);
  const files = listFiles(root);
  const js = files.filter((file) => /\.m?js$/.test(file));

  return {
    jsFiles: js.length,
    jsBytes: js.reduce((sum, file) => sum + statSync(join(root, file)).size, 0),
    jsGzipBytes: js.reduce((sum, file) => sum + gzipSync(readFileSync(join(root, file))).length, 0),
    allFiles: files.length,
    allBytes: files.reduce((sum, file) => sum + statSync(join(root, file)).size, 0),
  };
}

interface BuildSnapshot {
  readonly sizes: Record<string, GraphSize>;
  readonly clientChunks: readonly string[];
  readonly angularVersionCopies: number;
}

function snapshot(): BuildSnapshot {
  const clientFiles = listFiles(join(distDir, "client"));

  return {
    sizes: Object.fromEntries(
      [...BROWSER_DIRS, "ssr", "analog/server"].map((dir) => [dir, measure(dir)]),
    ),
    clientChunks: clientFiles
      .filter((file) => file.endsWith(".js"))
      .map((file) => `${file} (${statSync(join(distDir, "client", file)).size} B)`),
    // Each bundled copy of @angular/core writes the `ng-version` host attribute once.
    angularVersionCopies: clientFiles
      .filter((file) => file.endsWith(".js"))
      .reduce(
        (sum, file) =>
          sum +
          (readFileSync(join(distDir, "client", file), "utf8").match(/ng-version/g)?.length ?? 0),
        0,
      ),
  };
}

function printSizes(control: BuildSnapshot, poc: BuildSnapshot): void {
  console.log("\n| Output | Build | JS files | JS bytes | JS gzip | All files | All bytes |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");

  for (const dir of Object.keys(poc.sizes)) {
    for (const [label, build] of [
      ["plain SSR (control)", control],
      ["server component (PoC)", poc],
    ] as const) {
      const size = build.sizes[dir];

      if (size) {
        console.log(
          `| dist/${dir} | ${label} | ${size.jsFiles} | ${size.jsBytes} | ${size.jsGzipBytes} | ${size.allFiles} | ${size.allBytes} |`,
        );
      }
    }
  }

  console.log(`\ncontrol client chunks: ${control.clientChunks.join(", ")}`);
  console.log(`PoC client chunks:     ${poc.clientChunks.join(", ")}`);
  console.log(
    `bundled @angular/core copies (ng-version occurrences) — control: ${control.angularVersionCopies}, PoC: ${poc.angularVersionCopies}`,
  );
}

// 1. Control: the same app with the plugin disabled is ordinary SSR. Every
// server-only marker must then be in the browser output; otherwise the scan
// below would prove nothing.
section("Control build: plain SSR (STRATA_SERVER_COMPONENTS=off)");
build("control", { STRATA_SERVER_COMPONENTS: "off" });

for (const marker of SERVER_ONLY) {
  const found = filesWith(BROWSER_DIRS, marker);

  check(`control leaks ${marker} into the browser output`, found.length > 0, "not found");
}

const control = snapshot();

// 2. The PoC build.
section("PoC build: server component graph split");
build("PoC", {});

const poc = snapshot();

checkBrowserGraph();
checkServerGraph();

section("Bundle size");
printSizes(control, poc);

// 3. Production server.
section(`Production server: GET ${ROUTE}`);

const server = await startProductionServer();

try {
  const { baseUrl } = server;

  const response = await httpGet(`${baseUrl}${ROUTE}`);
  const html = response.body;

  check(
    "HTTP 200 text/html",
    response.status === 200 && !!response.contentType?.includes("text/html"),
  );
  check("SSR HTML contains <h1>Product 42</h1>", html.includes("<h1>Product 42</h1>"));
  check(
    "SSR HTML contains Server rendered product",
    html.includes("<p>Server rendered product</p>"),
  );
  check("SSR HTML contains the child's initial state (Count: 0)", html.includes("Count: 0"));
  check(
    "SSR HTML annotates the child for hydration (ngh) and marks its boundary",
    /<add-to-cart data-strata-client="add-to-cart" data-strata-props="[^"]*" ngh="\d+">/.test(html),
    html.match(/<add-to-cart[^>]*>/)?.[0] ?? "no <add-to-cart>",
  );
  check(
    "SSR HTML carries no server-only marker (only data crosses)",
    SERVER_ONLY.every((marker) => !html.includes(marker)),
  );
  console.log(
    `rendered: ${html.match(/<product-details[\s\S]*<\/product-details>/)?.[0] ?? "(missing)"}`,
  );

  // 4. Browser.
  section("Browser (Chromium via Playwright): hydration and interaction");

  const seen = await observeBrowser(`${baseUrl}${ROUTE}`);

  check("before scripts: SSR shows Product 42", seen.beforeScripts.productVisible);
  check(
    "before scripts: SSR shows Count: 0",
    seen.beforeScripts.count === "Count: 0",
    String(seen.beforeScripts.count),
  );
  check(
    "before scripts: child carries its ngh annotation, not yet hydrated",
    seen.beforeScripts.childHasHydrationAnnotation && !seen.beforeScripts.childMarkedHydrated,
  );
  check("child boundary hydrates", seen.hydratedWithinTimeout);
  check(
    "hydration reused the SSR DOM (same article, h1, button and text nodes)",
    Object.values(seen.sameNodes).every(Boolean),
    JSON.stringify(seen.sameNodes),
  );
  check(
    "Angular consumed every ngh annotation (no component left unhydrated)",
    seen.remainingHydrationAnnotations === 0,
    `${seen.remainingHydrationAnnotations} left`,
  );
  check("Product 42 visible", seen.productVisible);
  check(
    "Count: 0 after hydration",
    seen.countAfterHydration === "Count: 0",
    String(seen.countAfterHydration),
  );
  check(
    "click Add to cart → Count: 1",
    seen.countAfterClick === "Count: 1",
    String(seen.countAfterClick),
  );
  check("button is still the SSR node after the click", seen.buttonSurvivedClick);
  check(
    "no console errors, warnings or page errors",
    seen.errors.length === 0,
    seen.errors.join(" | "),
  );

  const loaded = seen.scripts.map((script) => new URL(script.url).pathname);
  const runtimeLeaks = SERVER_ONLY.filter((marker) =>
    seen.scripts.some((script) => script.body.includes(marker)),
  );

  check(
    "scripts the page actually loaded contain no server-only marker",
    runtimeLeaks.length === 0,
    runtimeLeaks.join(", "),
  );
  check(
    "scripts the page actually loaded contain the client component",
    seen.scripts.some((script) => script.body.includes(MARKERS.client)),
  );
  console.log(`loaded scripts: ${loaded.join(", ")}`);
} finally {
  await server.stop();
}

finish();
