import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { displayPath } from "./diagnostics.js";
import { strataServerComponents } from "./plugin.js";
import { applyAlias, createModuleResolver } from "./resolve.js";
import { SERVER_ONLY_SPECIFIER, reExportChain, scanServerOnlyModules } from "./server-only.js";

/**
 * Module identity across the supported resolution forms: relative paths,
 * index files, `.js` → `.ts`, Vite `resolve.alias` and tsconfig `paths`. The
 * resolver only ever answers with a scanned module.
 */

const MARK = `import "${SERVER_ONLY_SPECIFIER}";`;
let root: string;
let app: string;

const abs = (name: string): string => join(app, name);

const SOURCES: Record<string, string> = {
  "server/catalog.repository.ts": `${MARK}\nexport class CatalogRepository {}`,
  "lib/data.ts": `export { CatalogRepository } from "@/server/catalog.repository";`,
  "ui/index.ts": `export * from "@/lib/data";`,
  "ui/more.ts": `export * as data from "~lib/data";`,
  "ui/renamed.ts": `export { CatalogRepository as Repo } from "../lib/data.js";`,
  "ui/types.ts": `export type { CatalogRepository } from "@/server/catalog.repository";`,
  "app/client-widget.ts": `import { CatalogRepository } from "@/ui";\nexport const x = CatalogRepository;`,
  "shared/dto.ts": `export interface Dto { id: string }`,
  "shared/index.ts": `export * from "./dto";`,
  "cycle/a.ts": `export * from "./b";\nexport * from "@/server/catalog.repository";`,
  "cycle/b.ts": `export * from "./a";`,
  "via-ts-paths/barrel.ts": `export * from "#server/catalog.repository";`,
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "strata-resolve-"));
  app = join(root, "src");
  for (const [name, text] of Object.entries(SOURCES)) {
    mkdirSync(dirname(abs(name)), { recursive: true });
    writeFileSync(abs(name), text);
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "#server/*": ["src/server/*"] } },
    }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const files = (): string[] => Object.keys(SOURCES).map(abs).sort();
const read = (file: string): string => SOURCES[file.slice(app.length + 1)] ?? "";
const aliases = () => [
  { find: "@", replacement: app },
  { find: /^~lib\//, replacement: `${app}/lib/` },
];

function scan() {
  const modules = new Set(files());

  return scanServerOnlyModules(files(), read, () =>
    createModuleResolver({
      root,
      modules,
      aliases: aliases(),
      tsconfig: join(root, "tsconfig.json"),
    }),
  );
}

describe("applyAlias", () => {
  it("follows Vite: an exact or `find/` string match, or a RegExp replace", () => {
    const list = [
      { find: "@", replacement: "/abs/src" },
      { find: /^~(.*)$/, replacement: "/abs/$1" },
    ];

    expect(applyAlias("@", list)).toBe("/abs/src");
    expect(applyAlias("@/ui", list)).toBe("/abs/src/ui");
    expect(applyAlias("@scope/pkg", list)).toBeUndefined();
    expect(applyAlias("~x/y", list)).toBe("/abs/x/y");
  });

  it("is not defeated by a global RegExp keeping lastIndex", () => {
    const list = [{ find: /^@\//g, replacement: "/abs/" }];

    expect(applyAlias("@/a", list)).toBe("/abs/a");
    expect(applyAlias("@/b", list)).toBe("/abs/b");
  });
});

describe("createModuleResolver", () => {
  const modules = () => new Set(files());
  const resolver = () =>
    createModuleResolver({
      root,
      modules: modules(),
      aliases: aliases(),
      tsconfig: join(root, "tsconfig.json"),
    });

  it("resolves relative paths, index files and .js specifiers to TypeScript sources", () => {
    const resolveSpecifier = resolver();
    const from = abs("app/client-widget.ts");

    expect(resolveSpecifier("../shared", from)).toBe(abs("shared/index.ts"));
    expect(resolveSpecifier("../shared/dto", from)).toBe(abs("shared/dto.ts"));
    expect(resolveSpecifier("../shared/dto.js", from)).toBe(abs("shared/dto.ts"));
    expect(resolveSpecifier("../shared/dto.ts", from)).toBe(abs("shared/dto.ts"));
    expect(resolveSpecifier("../shared/dto.ts?raw", from)).toBe(abs("shared/dto.ts"));
  });

  it("resolves Vite string and RegExp aliases, including to an index file", () => {
    const resolveSpecifier = resolver();
    const from = abs("app/client-widget.ts");

    expect(resolveSpecifier("@/ui", from)).toBe(abs("ui/index.ts"));
    expect(resolveSpecifier("@/server/catalog.repository", from)).toBe(
      abs("server/catalog.repository.ts"),
    );
    expect(resolveSpecifier("~lib/data", from)).toBe(abs("lib/data.ts"));
  });

  it("resolves tsconfig paths through TypeScript", () => {
    expect(resolver()("#server/catalog.repository", abs("app/client-widget.ts"))).toBe(
      abs("server/catalog.repository.ts"),
    );
  });

  it("never resolves a package or a file outside the scanned set", () => {
    const resolveSpecifier = resolver();
    const from = abs("app/client-widget.ts");

    expect(resolveSpecifier("@angular/core", from)).toBeUndefined();
    expect(resolveSpecifier("lodash/fp", from)).toBeUndefined();
    expect(resolveSpecifier("@/missing", from)).toBeUndefined();
    expect(resolveSpecifier("../../../outside", from)).toBeUndefined();
  });

  it("ignores an unreadable tsconfig instead of failing the graph", () => {
    const resolveSpecifier = createModuleResolver({
      root,
      modules: modules(),
      tsconfig: resolve(root, "missing.json"),
    });

    expect(resolveSpecifier("#server/x", abs("app/client-widget.ts"))).toBeUndefined();
  });
});

describe("alias-aware re-export taint", () => {
  const relativeNames = (forbidden: ReadonlyMap<string, unknown>): string[] =>
    [...forbidden.keys()].map((file) => file.slice(app.length + 1)).sort();

  it("follows aliased, index, namespace and renamed re-exports to the assertion", () => {
    const forbidden = scan();

    expect(relativeNames(forbidden)).toEqual([
      "cycle/a.ts",
      "cycle/b.ts",
      "lib/data.ts",
      "server/catalog.repository.ts",
      "ui/index.ts",
      "ui/more.ts",
      "ui/renamed.ts",
      "via-ts-paths/barrel.ts",
    ]);
  });

  it("keeps the chain back to the assertion through aliases and an index barrel", () => {
    const forbidden = scan();
    const entry = forbidden.get(abs("ui/index.ts"));

    expect(entry && reExportChain(entry, forbidden).map((f) => f.slice(app.length + 1))).toEqual([
      "ui/index.ts",
      "lib/data.ts",
      "server/catalog.repository.ts",
    ]);
  });

  it("terminates on a re-export cycle and taints both members", () => {
    expect(relativeNames(scan())).toEqual(expect.arrayContaining(["cycle/a.ts", "cycle/b.ts"]));
  });

  it("ignores a type-only re-export and does not taint ordinary importers or shared modules", () => {
    const names = relativeNames(scan());

    expect(names).not.toContain("ui/types.ts");
    expect(names).not.toContain("app/client-widget.ts");
    expect(names).not.toContain("shared/dto.ts");
    expect(names).not.toContain("shared/index.ts");
  });

  it("without the alias resolver an aliased barrel is not registered (the load firewall covers it)", () => {
    const forbidden = scanServerOnlyModules(files(), read);

    expect(relativeNames(forbidden)).toEqual(["server/catalog.repository.ts"]);
  });
});

describe("displayPath", () => {
  it("shows app files relative to the root and never leaks an outside location", () => {
    expect(displayPath("/work/app/src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(displayPath("/work/app/node_modules/pkg/dist/index.js", "/work/app")).toBe(
      "node_modules/pkg/dist/index.js",
    );
    expect(displayPath("/work/node_modules/pkg/index.js", "/work/app")).toBe(
      "node_modules/pkg/index.js",
    );
    expect(displayPath("/home/someone/secret/x.ts", "/work/app")).toBe(
      "<outside the app root>/x.ts",
    );
  });
});

describe("plugin: aliases and packages in the client environment", () => {
  type Hook = (...args: unknown[]) => unknown;

  function instance(mapped: Record<string, string> = {}) {
    const plugin = strataServerComponents({ root, sourceDir: "src", generatedDir: "gen" });

    (plugin.config as Hook).call({}, {}, { command: "build", mode: "production" });
    (plugin.configResolved as Hook).call({}, { resolve: { alias: aliases() }, environments: {} });

    const context = (environment: string, importers: Record<string, string[]> = {}) => ({
      environment: { name: environment },
      resolve: (source: string, importer: string) => {
        const [path, query] = source.split("?");
        const target = mapped[path ?? ""] ?? applyAlias(path ?? "", aliases()) ?? path ?? "";
        const base = resolve(dirname(importer), target);
        const file = existsSync(base) && statSync(base).isDirectory() ? join(base, "index") : base;

        return Promise.resolve({
          id: `${file.endsWith(".ts") ? file : `${file}.ts`}${query ? `?${query}` : ""}`,
        });
      },
      getModuleInfo: (id: string) => ({ importers: importers[id] ?? [] }),
      error(message: string): never {
        throw new Error(message);
      },
    });

    return {
      resolveId: (source: string, importer: string, importers?: Record<string, string[]>) =>
        (plugin.resolveId as Hook).call(context("client", importers), source, importer, {}),
      resolveIdIn: (environment: string, source: string, importer: string) =>
        (plugin.resolveId as Hook).call(context(environment), source, importer, {}),
    };
  }

  it("rejects an aliased import of an aliased re-export chain, naming the importer and the chain", async () => {
    const widget = abs("app/client-widget.ts");
    const entry = abs("app/entry.ts");

    await expect(instance().resolveId("@/ui", widget, { [widget]: [entry] })).rejects.toThrow(
      new RegExp(
        [
          "Server-only module entered the browser graph: src/ui/index\\.ts",
          "Imported from: src/app/client-widget\\.ts",
          "Reason: it re-exports a server-only module: src/ui/index\\.ts → src/lib/data\\.ts → src/server/catalog\\.repository\\.ts[^\\n]*",
          "Import the browser-safe exports[^\\n]*",
          "Import chain[^:]*: src/app/entry\\.ts → src/app/client-widget\\.ts → src/ui/index\\.ts",
        ].join("\\n"),
      ),
    );
  });

  it("rejects a direct alias import and a tsconfig-paths import of the repository", async () => {
    const widget = abs("app/client-widget.ts");
    const plugin = instance({ "#server/catalog.repository": "../server/catalog.repository" });

    await expect(plugin.resolveId("@/server/catalog.repository", widget)).rejects.toThrow(
      "Server-only module entered the browser graph: src/server/catalog.repository.ts",
    );
    await expect(plugin.resolveId("#server/catalog.repository", widget)).rejects.toThrow(
      "Server-only module entered the browser graph: src/server/catalog.repository.ts",
    );
    await expect(plugin.resolveId("@/server/catalog.repository.ts?raw", widget)).rejects.toThrow(
      "src/server/catalog.repository.ts?raw",
    );
  });

  it("allows a shared module through an alias and the server environment through every route", async () => {
    const plugin = instance();
    const widget = abs("app/client-widget.ts");

    await expect(plugin.resolveId("@/shared", widget)).resolves.toBeNull();
    await expect(plugin.resolveIdIn("ssr", "@/ui", widget)).resolves.toBeNull();
  });

  it("rejects a package-style module that imports the assertion, whatever registered it", async () => {
    const pkgFile = join(root, "node_modules", "ui-kit", "dist", "server.js");

    await expect(instance().resolveId(SERVER_ONLY_SPECIFIER, pkgFile)).rejects.toThrow(
      /entered the browser graph: node_modules\/ui-kit\/dist\/server\.js[\s\S]*not exempt from the server-only contract/,
    );
  });

  it("leaves ordinary package imports alone", async () => {
    await expect(
      instance().resolveId("@angular/core", abs("app/client-widget.ts")),
    ).resolves.toBeNull();
  });
});
