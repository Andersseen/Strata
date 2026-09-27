import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { listFiles } from "../analog/lib/scan.ts";

import { checkDirectLoad } from "./lib/direct-load.ts";
import {
  BROWSER_DIRS,
  SERVER_ONLY,
  build as buildFixture,
  check,
  checkBrowserGraph,
  checkServerGraph,
  dirGraph,
  distDir,
  filesWith,
  finish as finishRun,
  measure,
  section,
  startProductionServer,
} from "./lib/harness.ts";
import type { GraphSize } from "./lib/harness.ts";

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
 *   (4 and 5 live in lib/direct-load.ts, shared with the Cloudflare run)
 */

const ROUTE = "/server-component";

function finish(): never {
  finishRun("server-component graph PoC");
}

function build(label: string, env: NodeJS.ProcessEnv): void {
  buildFixture(label, env, finish);
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
      [...BROWSER_DIRS, "ssr", "analog/server"].map((dir) => [dir, measure(dirGraph(dir, [dir]))]),
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

// 3. Production server: direct HTTP SSR, then Chromium.
const server = await startProductionServer();

try {
  await checkDirectLoad(server.baseUrl, ROUTE);
} finally {
  await server.stop();
}

finish();
