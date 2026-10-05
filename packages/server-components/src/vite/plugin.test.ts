import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { strataServerComponents } from "./plugin.js";
import { SERVER_ONLY_SPECIFIER } from "./server-only.js";

/**
 * The browser-graph firewall at the plugin's hooks, over a real temporary
 * app directory. `this.resolve` is a stand-in for Vite's resolver: relative
 * specifiers resolve to `<dir>/<name>.ts`, keeping any query. Real Vite
 * production builds are exercised by `pnpm test:server-component-server-only`.
 */

const MARK = `import "${SERVER_ONLY_SPECIFIER}";`;
const SOURCES: Record<string, string> = {
  "repository.ts": `${MARK}\nimport { format } from "./shared-format";\nexport class Repository {}`,
  "shared-format.ts": `export function format(value: string) { return value; }`,
  "barrel.ts": `export { Repository } from "./repository";`,
  "island.ts": `import { format } from "./shared-format";\nexport class Island {}`,
  "product.server-component.ts": `import { Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

@ServerComponent()
@Component({ selector: "product-card", template: "<p>server</p>" })
export class ProductCard {}`,
};

let root: string;
let app: string;

type Hook = (...args: unknown[]) => unknown;

function plugin(enabled = true) {
  const instance = strataServerComponents({
    root,
    sourceDir: "src/app",
    generatedDir: "src/generated",
    enabled,
  });

  (instance.config as Hook).call({}, {}, { command: "build", mode: "production" });

  return instance;
}

function hookContext(environment: string) {
  return {
    environment: { name: environment },
    resolve: (source: string, importer: string) => {
      const [path, query] = source.split("?");

      return Promise.resolve({
        id: `${resolve(dirname(importer), `${path}.ts`)}${query ? `?${query}` : ""}`,
      });
    },
    getModuleInfo: () => null,
    error(message: string): never {
      throw new Error(message);
    },
  };
}

function resolveIn(
  environment: string,
  source: string,
  importer = join(app, "island.ts"),
  instance = plugin(),
): Promise<unknown> {
  return (instance.resolveId as Hook).call(
    hookContext(environment),
    source,
    importer,
    {},
  ) as Promise<unknown>;
}

function loadIn(environment: string, id: string, instance = plugin()): unknown {
  return (instance.load as Hook).call(hookContext(environment), id);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "strata-server-only-"));
  app = join(root, "src", "app");
  mkdirSync(app, { recursive: true });

  for (const [name, text] of Object.entries(SOURCES)) writeFileSync(join(app, name), text);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("browser-graph firewall", () => {
  it("rejects a direct client import of a server-only module, naming module, importer and reason", async () => {
    const error = await resolveIn("client", "./repository").catch((e: Error) => e.message);

    expect(error).toBe(
      [
        "[strata] Server-only module entered the browser graph: src/app/repository.ts",
        "Imported from: src/app/island.ts",
        `Reason: the module declares \`${MARK}\`.`,
        "Move the dependency behind the Server Component boundary (use it only from a @ServerComponent() or the server-owned components it renders, and pass plain data to the island through [strataClient]), or remove the browser import.",
      ].join("\n"),
    );
  });

  it("rejects the module under any query (?raw, ?url, ?import&raw)", async () => {
    for (const query of ["raw", "url", "import&raw"]) {
      await expect(resolveIn("client", `./repository?${query}`)).rejects.toThrow(
        `Server-only module entered the browser graph: src/app/repository.ts?${query}`,
      );
    }
  });

  it("rejects a barrel that re-exports a server-only module, with the chain", async () => {
    await expect(resolveIn("client", "./barrel")).rejects.toThrow(
      "Reason: it re-exports a server-only module: src/app/barrel.ts → src/app/repository.ts",
    );
  });

  it("allows the shared dependency of a server-only module", async () => {
    await expect(resolveIn("client", "./shared-format")).resolves.toBeNull();
  });

  it("never restricts server environments", async () => {
    for (const environment of ["ssr", "nitro", "worker"]) {
      await expect(resolveIn(environment, "./repository")).resolves.toBeNull();
      await expect(resolveIn(environment, "./barrel")).resolves.toBeNull();
      expect(loadIn(environment, join(app, "repository.ts"))).toBeNull();
    }
  });

  it("is off for the plain-SSR control build", async () => {
    const control = plugin(false);

    await expect(resolveIn("client", "./repository", undefined, control)).resolves.toBeNull();
    expect(loadIn("client", join(app, "repository.ts?raw"), control)).toBeNull();
  });

  it("fails the load backstop for a module that bypassed resolution", () => {
    expect(() => loadIn("client", `${join(app, "barrel.ts")}?raw`)).toThrow(
      "[strata] Server-only module entered the browser graph: src/app/barrel.ts?raw\nImported from: unknown",
    );
  });

  it("rejects the assertion itself in the client graph (a marked module outside sourceDir)", async () => {
    await expect(
      resolveIn("client", SERVER_ONLY_SPECIFIER, join(root, "src", "server", "db.ts")),
    ).rejects.toThrow(
      "[strata] Server-only module entered the browser graph: src/server/db.ts\nImported from: unknown",
    );
  });

  it("still redirects a Server Component module to its surrogate", async () => {
    await expect(resolveIn("client", "./product.server-component")).resolves.toBe(
      join(root, "src", "generated", "product.server-component.ts"),
    );
  });

  it("rejects a query import of a Server Component module, which would bypass the surrogate", async () => {
    await expect(resolveIn("client", "./product.server-component?raw")).rejects.toThrow(
      "[strata] Server Component module entered the browser graph: src/app/product.server-component.ts?raw\nImported from: src/app/island.ts",
    );
  });

  it("names the Server Component behind a surrogate importer", async () => {
    const surrogate = join(root, "src", "generated", "product.server-component.ts");

    await expect(resolveIn("client", "../app/repository", surrogate)).rejects.toThrow(
      "Imported from: src/generated/product.server-component.ts (the generated browser surrogate of src/app/product.server-component.ts, which imports its [strataClient] islands)",
    );
  });

  it("keeps the Server Component load backstop", () => {
    expect(() => loadIn("client", join(app, "product.server-component.ts"))).toThrow(
      "[strata] Server Component module entered the browser graph: src/app/product.server-component.ts",
    );
  });
});
