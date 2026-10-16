import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  entryScriptOf,
  measureBuild,
  packageName,
  packageOfSource,
  scanMarkers,
  scanTargets,
  sourceModulesByPackage,
} from "./graph.ts";

/** A miniature Nitro output: browser entry + lazy chunk + maps, server entry graph + traced module. */
function fakeOutput(preset: "node-server" | "cloudflare-pages"): string {
  const root = mkdtempSync(join(tmpdir(), "perf-graph-test-"));
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const cloudflare = preset === "cloudflare-pages";
  const server = cloudflare ? "public/_worker.js" : "server";
  const entry = cloudflare ? "index.js" : "index.mjs";

  put("public/index.html", '<script type="module" crossorigin src="/assets/main.js"></script>');
  put(
    "public/assets/main.js",
    'import "./shared.js";\nexport const lazy = () => import("./lazy.js");\n'.repeat(5),
  );
  put("public/assets/shared.js", "export const shared = 'S'.repeat(500);\n");
  put("public/assets/lazy.js", "export const lazy = 'L'.repeat(300);\n");
  put(
    "public/assets/main.js.map",
    JSON.stringify({
      sources: ["../../node_modules/@angular/core/fesm/core.mjs", "../src/app/a.ts"],
    }),
  );
  put("public/assets/style.css", "body{color:red}");
  put(
    `${server}/${entry}`,
    'import "./chunks/nitro.mjs";\nexport default () => import("./chunks/lazy-page.mjs");\n',
  );
  put(
    `${server}/chunks/nitro.mjs`,
    'import fs from "node:fs";\nimport "rxjs";\nexport const n = 1;\n',
  );
  put(`${server}/chunks/lazy-page.mjs`, "export const p = 'P'.repeat(400);\n");
  put(`${server}/chunks/orphan.mjs`, "export const orphan = 'O'.repeat(900);\n");
  put(`${server}/${entry}.map`, "{}");
  if (!cloudflare) {
    put("server/node_modules/rxjs/index.js", "export {}");
    put("server/node_modules/@scope/pkg/index.js", "export {}");
  }
  put("nitro.json", "{}");

  return root;
}

describe("measureBuild", () => {
  const root = fakeOutput("node-server");
  const m = measureBuild({ root, preset: "node-server", entryScript: "assets/main.js" });

  it("measures browser JS without source maps, CSS or metadata", () => {
    expect(m.browser.js.files).toBe(3);
    expect(m.browser.css.files).toBe(1);
    expect(m.browser.js.raw).toBeGreaterThan(m.browser.initialEntry.raw);
    expect(m.browser.js.gzip).toBeGreaterThan(0);
    expect(m.browser.js.brotli).toBeGreaterThan(0);
  });

  it("splits the initial static graph from lazy chunks without double counting", () => {
    expect(m.browser.initialGraph.files).toBe(2);
    expect(m.browser.lazy.files).toBe(1);
    expect(m.browser.initialGraph.raw + m.browser.lazy.raw).toBe(m.browser.js.raw);
  });

  it("counts only the modules reachable from the server entry, not an orphan file", () => {
    expect(m.server.bundledJs.files).toBe(4);
    expect(m.server.entryReachable.modules).toBe(3);
    expect(m.server.entryEager.modules).toBe(2);
    expect(m.server.entryReachable.raw).toBeLessThan(m.server.bundledJs.raw);
    expect(m.server.chunks.map((c) => c.file)).not.toContain("chunks/orphan.mjs");
  });

  it("separates Node built-ins, external packages and traced node_modules", () => {
    expect(m.server.nodeBuiltins).toEqual(["node:fs"]);
    expect(m.server.externalPackages).toEqual(["rxjs"]);
    expect(m.server.tracedNodeModules.packages).toEqual(["@scope/pkg", "rxjs"]);
    expect(m.server.tracedNodeModules.files).toBe(2);
  });

  it("keeps node_modules out of the bundled server bytes", () => {
    expect(m.server.bundledJs.files).toBe(4);
  });

  it("reports the deployable directory by class with source maps separate", () => {
    expect(m.deployable.directory).toBe("dist/analog");
    expect(m.deployable.byClass.sourcemap.files).toBe(2);
    expect(m.deployable.byClass.html.files).toBe(1);
    expect(m.deployable.byClass.metadata.files).toBe(1);
    expect(Object.values(m.deployable.byClass).reduce((n, c) => n + c.files, 0)).toBe(
      m.deployable.files,
    );
  });

  it("groups browser source modules by package", () => {
    expect(m.browser.sourceModulesByPackage).toEqual({ "@angular/core": 1, app: 1 });
  });

  it("measures a Cloudflare Worker from public/_worker.js and excludes it from browser assets", () => {
    const cf = measureBuild({
      root: fakeOutput("cloudflare-pages"),
      preset: "cloudflare-pages",
      entryScript: "assets/main.js",
    });

    expect(cf.server.entry).toBe("index.js");
    expect(cf.server.tracedNodeModules.files).toBe(0);
    expect(cf.browser.js.files).toBe(3);
    expect(cf.deployable.directory).toBe("dist/analog/public");
  });

  it("refuses to measure a failed build or an entry that is not in the output", () => {
    expect(() =>
      measureBuild({
        root: mkdtempSync(join(tmpdir(), "perf-empty-")),
        preset: "node-server",
        entryScript: "a.js",
      }),
    ).toThrow(/failed build is not a measurement/);
    expect(() =>
      measureBuild({ root, preset: "node-server", entryScript: "assets/missing.js" }),
    ).toThrow(/entry assets\/missing.js/);
  });
});

describe("scanning", () => {
  const root = fakeOutput("node-server");

  it("scans browser files including maps, and server JavaScript only", () => {
    const targets = scanTargets(root, "node-server");

    expect(targets.browser.some((f) => f.endsWith("main.js.map"))).toBe(true);
    expect(targets.server.every((f) => !f.endsWith(".map") && !f.includes("node_modules"))).toBe(
      true,
    );
  });

  it("returns an empty list for a marker that is absent, never undefined", () => {
    const found = scanMarkers(scanTargets(root, "node-server").server, [
      "P'.repeat(400)",
      "NOT_THERE",
    ]);

    expect(found["P'.repeat(400)"]).toHaveLength(1);
    expect(found["NOT_THERE"]).toEqual([]);
  });
});

describe("helpers", () => {
  it("parses the browser entry from the SSR document", () => {
    expect(
      entryScriptOf('<script type="module" crossorigin src="/assets/index-x.js"></script>'),
    ).toBe("assets/index-x.js");
    expect(entryScriptOf("<html></html>")).toBeUndefined();
  });

  it("names packages from node_modules paths, Angular's build tree and app sources", () => {
    expect(packageOfSource("../../node_modules/@strata-sc/server-components/dist/x.js")).toBe(
      "@strata-sc/server-components",
    );
    expect(packageOfSource("../../node_modules/a/node_modules/rxjs/x.js")).toBe("rxjs");
    expect(packageOfSource("../../../bin/packages/core/src/x.ts")).toBe("@angular/core");
    expect(packageOfSource("../src/app/page.ts")).toBe("app");
    expect(packageName("@scope/pkg/deep/file")).toBe("@scope/pkg");
    expect(packageName("rxjs/operators")).toBe("rxjs");
  });

  it("counts a module shared by two maps once", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-maps-"));
    const a = join(dir, "a.map");
    const b = join(dir, "b.map");

    writeFileSync(
      a,
      JSON.stringify({ sources: ["../node_modules/rxjs/a.js", "../node_modules/rxjs/b.js"] }),
    );
    writeFileSync(b, JSON.stringify({ sources: ["../node_modules/rxjs/a.js"] }));

    expect(sourceModulesByPackage([a, b])).toEqual({ rxjs: 2 });
  });
});
