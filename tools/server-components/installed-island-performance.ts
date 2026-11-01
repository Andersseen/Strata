import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { chromium } from "playwright";

import { findFreePort, httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";

import { check, finish, repoRoot, section } from "./lib/harness.ts";
import { prepareWorkspace, sanitize, writeConsumerFile } from "./lib/installed-island.ts";
import { startNodeServer, startServer } from "./lib/package-consumer.ts";

/**
 * `pnpm test:server-component-installed-island-performance`: measures the installed-reference path
 * against the local-component path with repeatable fixtures. It asserts that every measured page
 * is correct (hydrated, no error) and prints distributions; it never gates on a time, because a
 * wall-clock threshold on shared hardware would be a flaky claim, not evidence.
 *
 * Reported per variant: generated reference-module size, browser/server JavaScript raw and gzip,
 * host preflight+commit time (`elapsedMs` of the hydration observation) over repeated cold-context
 * loads, and dev-server optimizer behaviour. Registry construction is measured separately in
 * isolation against the built package (no browser), not folded into a page time.
 */

const TITLE = "server-component installed-island performance";
const SAMPLES = Number(process.env["STRATA_PERF_SAMPLES"] ?? "11");

interface Variant {
  readonly name: string;
  readonly kind: "local" | "package" | "mixed";
  readonly count: number;
  /** Boundaries, in template order. */
  readonly boundaries: readonly ("counter" | "picker" | "badge")[];
}

const repeat = (
  kind: "counter" | "picker" | "badge",
  count: number,
): ("counter" | "picker" | "badge")[] => Array.from({ length: count }, () => kind);

const VARIANTS: readonly Variant[] = [
  ...[1, 8, 32].map((count) => ({
    name: `local-${count}`,
    kind: "local" as const,
    count,
    boundaries: repeat("counter", count),
  })),
  ...[1, 8, 32].map((count) => ({
    name: `package-${count}`,
    kind: "package" as const,
    count,
    boundaries: repeat("picker", count),
  })),
  {
    name: "mixed-32",
    kind: "mixed",
    count: 32,
    boundaries: [...repeat("picker", 16), ...repeat("badge", 16)],
  },
];

const className = (name: string): string =>
  name
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

const BOUNDARY = {
  counter: `<legacy-counter [start]="0" [strataClient]="{ start: 0 }" />`,
  picker: `<acme-product-picker [productView]="view" [strataClient]="{ productView: view }" />`,
  badge: `<acme-stock-badge [label]="label" [stockQuantity]="3" [strataClient]="{ label: label, stockQuantity: 3 }" />`,
} as const;

function serverComponent(variant: Variant): string {
  const usesCounter = variant.boundaries.includes("counter");
  const usesPicker = variant.boundaries.includes("picker");
  const usesBadge = variant.boundaries.includes("badge");
  const imports = [
    usesCounter ? "LegacyCounterComponent" : "",
    usesPicker ? "ProductPickerComponent" : "",
    usesBadge ? "StockBadgeComponent" : "",
    "StrataClientBoundary",
  ].filter(Boolean);

  return `import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
${usesPicker ? 'import { ProductPickerComponent } from "@strata-test/angular-widgets";\n' : ""}${usesBadge ? 'import { StockBadgeComponent } from "@strata-test/angular-widgets/second";\n' : ""}${usesCounter ? 'import { LegacyCounterComponent } from "./legacy-counter.component";\n' : ""}
@ServerComponent()
@Component({
  selector: "perf-${variant.name}",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [${imports.join(", ")}],
  template: \`<section>${variant.boundaries.map((kind) => BOUNDARY[kind]).join("\n")}</section>\`,
})
export class Perf${className(variant.name)}ServerComponent {
  protected readonly label = "Units";
  protected readonly view = {
    id: "1",
    name: "Product",
    variants: [{ id: "black", label: "Black", stock: 12 }],
  };
}
`;
}

function page(variant: Variant): string {
  const component = `Perf${className(variant.name)}ServerComponent`;

  return `import { ChangeDetectionStrategy, Component } from "@angular/core";

import { ${component} } from "../product/perf-${variant.name}.server-component";

@Component({
  selector: "app-perf-${variant.name}-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [${component}],
  template: \`<main><perf-${variant.name} /></main>\`,
})
export default class Perf${className(variant.name)}Page {}
`;
}

// ---------------------------------------------------------------------------
const stats = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const median = at(0.5);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);

  return {
    n: sorted.length,
    min: sorted[0]!,
    median,
    p90: at(0.9),
    max: sorted.at(-1)!,
    mad: deviations[Math.floor(deviations.length / 2)]!,
  };
};
const ms = (value: number): string => value.toFixed(2);

const workspace = prepareWorkspace();
const { consumerDir, env } = workspace;
const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const sizeOf = (files: readonly string[]): { raw: number; gzip: number } => {
  let raw = 0;
  let gzip = 0;

  for (const file of files) {
    const body = readFileSync(dist(file));

    raw += body.length;
    gzip += gzipSync(body).length;
  }

  return { raw, gzip };
};
const filesIn = (dir: string): string[] =>
  existsSync(dist(dir)) ? listFiles(dist(dir)).map((file) => `${dir}/${file}`) : [];

const versionOf = (name: string): string =>
  (
    JSON.parse(readFileSync(join(consumerDir, "node_modules", name, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;

const report: Record<string, unknown> = {};

try {
  section("Environment");

  const environment = {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCores: cpus().length,
    samples: SAMPLES,
    angular: versionOf("@angular/core"),
    vite: versionOf("vite"),
  };

  console.log(JSON.stringify(environment));
  report["environment"] = environment;

  // ------------------------------------------------------------------------
  section("Registry construction (isolated, Node, built package, Angular JIT metadata)");

  const packageDir = join(repoRoot, "packages", "server-components");
  const packageRequire = createRequire(join(packageDir, "package.json"));

  await import(pathToFileURL(packageRequire.resolve("@angular/compiler")).href);

  const { Component } = (await import(
    pathToFileURL(packageRequire.resolve("@angular/core")).href
  )) as {
    Component: (this: void, metadata: object) => (type: unknown) => void;
  };
  const { buildClientReferenceRegistry } = (await import(
    pathToFileURL(join(packageDir, "dist", "fesm2022", "client-references.js")).href
  )) as {
    buildClientReferenceRegistry: (
      this: void,
      inputs: readonly unknown[],
    ) => {
      references: ReadonlyMap<string, unknown>;
      problem?: string;
    };
  };
  const components = Array.from({ length: 32 }, (_, index) => {
    const type = class {};
    const selector = `perf-reference-${index}`;

    Component({ selector, template: "", standalone: true })(type);

    return { type, expectedSelector: selector };
  });
  const registryCases: [string, readonly unknown[]][] = [
    ["1 distinct", components.slice(0, 1)],
    ["8 distinct", components.slice(0, 8)],
    ["32 distinct", components.slice(0, 32)],
    ["32 repeated references to 1 component", Array.from({ length: 32 }, () => components[0])],
  ];
  const registryRows: Record<string, unknown>[] = [];
  const ITERATIONS = 2_000;

  for (const [label, inputs] of registryCases) {
    const samples: number[] = [];

    for (let sample = 0; sample < 21; sample++) {
      const startedAt = performance.now();

      for (let i = 0; i < ITERATIONS; i++) buildClientReferenceRegistry(inputs);
      samples.push(((performance.now() - startedAt) * 1000) / ITERATIONS);
    }
    samples.shift();

    const distribution = stats(samples);

    check(
      `registry, ${label}: valid, ${label.startsWith("32 repeated") ? 1 : inputs.length} reference(s)`,
      buildClientReferenceRegistry(inputs).problem === undefined,
    );
    registryRows.push({
      case: label,
      "median µs": ms(distribution.median),
      "min–max µs": `${ms(distribution.min)}–${ms(distribution.max)}`,
      "MAD µs": ms(distribution.mad),
      samples: distribution.n,
    });
  }
  report["registry"] = registryRows;
  console.table(registryRows);

  for (const variant of VARIANTS) {
    writeConsumerFile(
      consumerDir,
      `src/app/product/perf-${variant.name}.server-component.ts`,
      serverComponent(variant),
    );
    writeConsumerFile(consumerDir, `src/app/pages/perf-${variant.name}.page.ts`, page(variant));
  }

  // ------------------------------------------------------------------------
  section("Build");

  workspace.clean();

  const started = performance.now();
  const built = workspace.vite(["build"]);
  const buildSeconds = (performance.now() - started) / 1000;

  check(
    "the production build with all variants succeeds",
    built.status === 0,
    sanitize(built.stderr).slice(-1_200),
  );
  report["buildSeconds"] = buildSeconds;

  // ------------------------------------------------------------------------
  section("Bundle and generated-module sizes");

  const browserFiles = filesIn("client").filter((file) => file.endsWith(".js"));
  const serverFiles = [...filesIn("ssr"), ...filesIn("analog/server")].filter((file) =>
    /\.m?js$/.test(file),
  );
  const rows: Record<string, unknown>[] = [];

  for (const variant of VARIANTS) {
    const generated = `src/generated/server-components/product/perf-${variant.name}.server-component.ts`;
    const chunkPattern = new RegExp(
      `/perf-${variant.name}\\.(?:server-component|page)-[^/]*\\.js$`,
    );
    const clientChunk = browserFiles.filter((file) => chunkPattern.test(file));
    const serverChunk = filesIn("ssr").filter(
      (file) => chunkPattern.test(file) && file.endsWith(".js"),
    );

    check(
      `${variant.name}: one generated module, one browser chunk and one server chunk exist`,
      existsSync(join(consumerDir, generated)) &&
        clientChunk.length === 1 &&
        serverChunk.length === 1,
    );
    rows.push({
      variant: variant.name,
      generatedModuleBytes: readFileSync(join(consumerDir, generated)).length,
      browserChunk: sizeOf(clientChunk),
      serverChunk: sizeOf(serverChunk),
    });
  }
  report["sizes"] = rows;
  report["totals"] = {
    browserJs: sizeOf(browserFiles),
    serverJs: sizeOf(serverFiles),
    note: "all variants and pages of the consumer, including shared framework chunks",
  };
  console.table(
    rows.map((row) => ({
      variant: row["variant"],
      "generated .ts B": row["generatedModuleBytes"],
      "browser chunk B": (row["browserChunk"] as { raw: number }).raw,
      "browser chunk gz": (row["browserChunk"] as { gzip: number }).gzip,
      "server chunk B": (row["serverChunk"] as { raw: number }).raw,
      "server chunk gz": (row["serverChunk"] as { gzip: number }).gzip,
    })),
  );

  // ------------------------------------------------------------------------
  section("Hydration: host preflight + commit (observer elapsedMs), page JavaScript");

  const server = await startNodeServer(consumerDir, env);
  const browser = await chromium.launch();
  const timings: Record<string, unknown>[] = [];

  try {
    for (const variant of VARIANTS) {
      const elapsed: number[] = [];
      const ready: number[] = [];
      let javascript = { raw: 0, gzip: 0 };
      let allCorrect = true;

      for (let sample = 0; sample < SAMPLES + 1; sample++) {
        const context = await browser.newContext();
        const tab = await context.newPage();
        const errors: string[] = [];
        let raw = 0;
        let gzip = 0;

        tab.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        tab.on("response", async (response) => {
          if (response.request().resourceType() !== "script") return;

          const body = await response.body().catch(() => Buffer.alloc(0));

          raw += body.length;
          gzip += gzipSync(body).length;
        });

        const navigationStart = performance.now();

        await tab.goto(`${server.baseUrl}/perf-${variant.name}`, { waitUntil: "load" });
        await tab.waitForFunction(
          () =>
            ((globalThis as { __STRATA_HYDRATION_OBSERVATIONS__?: unknown[] })
              .__STRATA_HYDRATION_OBSERVATIONS__?.length ?? 0) >= 1,
          undefined,
          { timeout: 20_000 },
        );

        const readyMs = performance.now() - navigationStart;
        const observation = await tab.evaluate(
          () =>
            (
              globalThis as {
                __STRATA_HYDRATION_OBSERVATIONS__?: {
                  outcome: string;
                  discoveredBoundaries: number;
                  committedBoundaries: number;
                  elapsedMs: number;
                }[];
              }
            ).__STRATA_HYDRATION_OBSERVATIONS__![0]!,
        );

        // The first sample warms the server and the HTTP stack; it is discarded.
        if (sample > 0) {
          elapsed.push(observation.elapsedMs);
          ready.push(readyMs);
          javascript = { raw, gzip };
        }
        if (
          observation.outcome !== "committed" ||
          observation.committedBoundaries !== variant.count ||
          errors.length > 0
        ) {
          allCorrect = false;
        }
        await context.close();
      }

      check(
        `${variant.name}: every sample committed ${variant.count} boundaries with no console error`,
        allCorrect,
      );
      timings.push({
        variant: variant.name,
        elapsedMs: stats(elapsed),
        loadToCommittedMs: stats(ready),
        pageJavaScript: javascript,
      });
    }
  } finally {
    await browser.close();
    await server.stop();
  }

  report["hydration"] = timings;
  console.table(
    timings.map((row) => {
      const e = row["elapsedMs"] as ReturnType<typeof stats>;
      const r = row["loadToCommittedMs"] as ReturnType<typeof stats>;
      const j = row["pageJavaScript"] as { raw: number; gzip: number };

      return {
        variant: row["variant"],
        "preflight+commit median ms": ms(e.median),
        "min–max": `${ms(e.min)}–${ms(e.max)}`,
        MAD: ms(e.mad),
        "load→committed median ms": ms(r.median),
        "page JS B": j.raw,
        "page JS gz": j.gzip,
      };
    }),
  );

  // ------------------------------------------------------------------------
  section("Development optimizer");

  const devRuns: Record<string, unknown>[] = [];

  for (const cache of ["clean", "warm"] as const) {
    for (let run = 0; run < 3; run++) {
      if (cache === "clean") workspace.clean({ vite: true });

      const port = await findFreePort();
      const startedAt = performance.now();
      const dev = await startServer(
        process.execPath,
        [
          join(consumerDir, "node_modules", "vite", "bin", "vite.js"),
          "--port",
          String(port),
          "--strictPort",
          "--host",
          "127.0.0.1",
        ],
        { cwd: consumerDir, env, port, readyPath: "/" },
      );
      const readyMs = performance.now() - startedAt;
      const requestStart = performance.now();
      const response = await httpGet(`${dev.baseUrl}/perf-package-8`);
      const firstRequestMs = performance.now() - requestStart;

      // The optimizer finishes after the first request; wait for its metadata, then stop.
      const depsDir = join(consumerDir, "node_modules", ".vite", "deps");
      const optimizerStart = performance.now();

      while (
        !existsSync(join(depsDir, "_metadata.json")) &&
        performance.now() - optimizerStart < 30_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const optimizerMs = performance.now() - requestStart;

      await dev.stop();

      const deps = existsSync(depsDir) ? readdirSync(depsDir).filter((f) => f.endsWith(".js")) : [];

      devRuns.push({
        cache,
        run,
        readyMs,
        firstRequestMs,
        optimizerSettledMs: optimizerMs,
        status: response.status,
        prebundled: deps.length,
        installedLibraryPrebundled: deps.some((file) => /angular-widgets/.test(file)),
      });
      check(
        `dev, ${cache} cache, run ${run + 1}: /perf-package-8 renders 8 package boundaries`,
        response.status === 200 &&
          (response.body.match(/data-strata-client="acme-product-picker"/g)?.length ?? 0) === 8,
      );
    }
  }
  report["dev"] = devRuns;
  console.table(
    devRuns.map((row) => ({
      cache: row["cache"],
      "ready ms": Math.round(row["readyMs"] as number),
      "first /perf-package-8 ms": Math.round(row["firstRequestMs"] as number),
      "request→optimizer settled ms": Math.round(row["optimizerSettledMs"] as number),
      "prebundled files": row["prebundled"],
      "library prebundled": row["installedLibraryPrebundled"],
    })),
  );

  const reportPath = process.env["STRATA_PERF_REPORT"];

  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.log(` FAIL ${error instanceof Error ? error.stack : String(error)}`);
  check("performance run completed", false);
} finally {
  workspace.dispose();
}

finish(TITLE);
