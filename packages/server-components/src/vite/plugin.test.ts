import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// ---------------------------------------------------------------------------
// Dev server: hot regeneration through `hotUpdate`, with a stand-in Vite server.

interface FakeEnvironment {
  readonly name: string;
  readonly hot: { send: ReturnType<typeof vi.fn> };
  readonly moduleGraph: {
    getModulesByFile: ReturnType<typeof vi.fn>;
    invalidateModule: ReturnType<typeof vi.fn>;
    invalidateAll: ReturnType<typeof vi.fn>;
  };
}

describe("dev server: hotUpdate", () => {
  const SC = (message: string, extra = ""): string => `import { Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
${extra ? `import { Island } from "./island";` : ""}
@ServerComponent()
@Component({
  selector: "product-card",
  imports: [StrataClientBoundary${extra ? ", Island" : ""}],
  template: \`<p>${message}</p>${extra}\`,
})
export class ProductCard {}`;

  let dir: string;
  let source: string;
  let generatedDir: string;
  let stamp = 0;

  const write = (name: string, text: string): string => {
    const path = join(source, name);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);

    return path;
  };

  function environment(name: string): FakeEnvironment {
    return {
      name,
      hot: { send: vi.fn() },
      moduleGraph: {
        getModulesByFile: vi.fn(() => undefined),
        invalidateModule: vi.fn(),
        invalidateAll: vi.fn(),
      },
    };
  }

  function boot() {
    const environments = { client: environment("client"), ssr: environment("ssr") };
    const logger = { info: vi.fn(), error: vi.fn() };
    const server = { environments, config: { logger } };
    const instance = strataServerComponents({
      root: dir,
      sourceDir: "src/app",
      generatedDir: "src/generated",
      enabled: true,
    });

    (instance.config as Hook).call({}, {}, { command: "serve", mode: "development" });
    (instance.configureServer as Hook).call({}, server);

    /** One watcher event, delivered to every environment in Vite's order. */
    const deliver = (type: "create" | "update" | "delete", file: string) => {
      const timestamp = ++stamp;
      const results = [environments.client, environments.ssr].map((env) =>
        (instance.hotUpdate as Hook).call({ environment: env }, { type, file, timestamp, server }),
      );

      return { client: results[0], ssr: results[1] };
    };
    const reloads = (): number =>
      environments.client.hot.send.mock.calls.filter(
        ([payload]) => (payload as { type: string }).type === "full-reload",
      ).length;
    const errors = (): unknown[] =>
      environments.client.hot.send.mock.calls
        .map(([payload]) => payload as { type: string })
        .filter((payload) => payload.type === "error");

    return { instance, environments, logger, deliver, reloads, errors };
  }

  const generatedFile = (): string => join(generatedDir, "product.server-component.ts");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-dev-"));
    source = join(dir, "src", "app");
    generatedDir = join(dir, "src", "generated");
    mkdirSync(source, { recursive: true });
    write("island.ts", `export class Island {}`);
    write("shared.ts", `export const shared = 1;`);
    write("product.server-component.ts", SC("A"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the initial graph at config(), before any watcher event", () => {
    boot();

    expect(readFileSync(generatedFile(), "utf8")).toContain('selector: "product-card"');
  });

  it("reloads the document once, from the last environment, after a server-owned edit", () => {
    const dev = boot();
    const file = write("product.server-component.ts", SC("B"));
    const { client, ssr } = dev.deliver("update", file);

    expect(dev.reloads()).toBe(1);
    expect(dev.environments.ssr.hot.send).not.toHaveBeenCalled();
    // The client environment's own module update is superseded by the reload.
    expect(client).toEqual([]);
    expect(ssr).toBeUndefined();
  });

  it("leaves a client-owned edit to the framework: no reload, no module filtering", () => {
    const dev = boot();
    const { client, ssr } = dev.deliver(
      "update",
      write("island.ts", `export class Island { a = 1 }`),
    );

    expect(dev.reloads()).toBe(0);
    expect(client).toBeUndefined();
    expect(ssr).toBeUndefined();
  });

  it("ignores files outside the app sources", () => {
    const dev = boot();

    expect(dev.deliver("update", join(dir, "README.md")).client).toBeUndefined();
    expect(dev.reloads()).toBe(0);
  });

  it("does not regenerate from its own writes (no watcher loop) and rewrites no identical surrogate", () => {
    const dev = boot();
    const before = statSync(generatedFile()).mtimeMs;

    expect(dev.deliver("update", generatedFile())).toEqual({ client: undefined, ssr: undefined });
    expect(dev.logger.info).not.toHaveBeenCalled();

    dev.deliver("update", write("island.ts", `export class Island { b = 2 }`));

    // The graph is unchanged, so the surrogate is left alone: no file event follows.
    expect(statSync(generatedFile()).mtimeMs).toBe(before);
    expect(dev.reloads()).toBe(0);
  });

  it("invalidates the client module of a regenerated surrogate before the reload", () => {
    const dev = boot();
    const module = { id: "surrogate" };

    write(
      "island.ts",
      `import { Component } from "@angular/core";
@Component({ selector: "p-island", template: "" })
export class Island {}`,
    );
    dev.environments.client.moduleGraph.getModulesByFile.mockImplementation((file: string) =>
      file === generatedFile() ? new Set([module]) : undefined,
    );

    const file = write("product.server-component.ts", SC("B", `<p-island [strataClient]="{}" />`));

    dev.deliver("update", file);

    expect(dev.environments.client.moduleGraph.invalidateModule).toHaveBeenCalledWith(
      module,
      expect.anything(),
    );
    // Written surrogate not yet reported by the watcher: no reload so far.
    expect(dev.reloads()).toBe(0);

    dev.deliver("update", generatedFile());

    expect(dev.reloads()).toBe(1);
    expect(readFileSync(generatedFile(), "utf8")).toContain("Island");
  });

  it("falls back to reloading if the watcher never reports the surrogate", () => {
    vi.useFakeTimers();

    const dev = boot();

    write(
      "island.ts",
      `import { Component } from "@angular/core";
@Component({ selector: "p-island", template: "" })
export class Island {}`,
    );
    dev.deliver(
      "update",
      write("product.server-component.ts", SC("B", `<p-island [strataClient]="{}" />`)),
    );
    expect(dev.reloads()).toBe(0);

    vi.advanceTimersByTime(2_500);

    expect(dev.reloads()).toBe(1);
  });

  it("deleting a Server Component removes its surrogate and reloads", () => {
    const dev = boot();

    rmSync(join(source, "product.server-component.ts"));
    dev.deliver("delete", join(source, "product.server-component.ts"));
    dev.deliver("delete", generatedFile());

    expect(existsSync(generatedFile())).toBe(false);
    expect(dev.reloads()).toBe(1);
  });

  it("creating a Server Component generates its surrogate", () => {
    const dev = boot();
    const file = write(
      "second.server-component.ts",
      SC("2").replace("product-card", "second-card").replace("ProductCard", "SecondCard"),
    );

    dev.deliver("create", file);

    expect(existsSync(join(generatedDir, "second.server-component.ts"))).toBe(true);
  });

  describe("an analysis failure", () => {
    const BROKEN = SC("x").replace("<p>x</p>", `<button (click)="go()">x</button>`);

    it("keeps the committed graph and surrogates, reports once, and closes the client graph", async () => {
      const dev = boot();
      const surrogate = readFileSync(generatedFile(), "utf8");

      dev.deliver("update", write("product.server-component.ts", BROKEN));

      expect(readFileSync(generatedFile(), "utf8")).toBe(surrogate);
      expect(dev.reloads()).toBe(0);
      expect(dev.errors()).toHaveLength(1);
      expect(dev.logger.error).toHaveBeenCalledTimes(1);
      expect(dev.logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Interactive binding "(click)" on <button>'),
        expect.anything(),
      );
      expect(dev.environments.client.moduleGraph.invalidateAll).toHaveBeenCalled();

      // The stale graph is not safety metadata: any app module is refused...
      expect(() => loadIn("client", join(source, "island.ts"), dev.instance)).toThrow(
        "could not be refreshed",
      );
      await expect(
        resolveIn("client", "./island", join(source, "shared.ts"), dev.instance),
      ).rejects.toThrow("could not be refreshed");
      // ...while modules outside the app, and server environments, are not.
      expect(loadIn("client", join(dir, "node_modules", "x.js"), dev.instance)).toBeNull();
      expect(loadIn("ssr", join(source, "island.ts"), dev.instance)).toBeNull();
    });

    it("does not apply a stale server-only map: a newly asserted module stays refused", () => {
      const dev = boot();

      // The edit asserts server-only in a shared module and, in the same moment,
      // another file breaks the analysis. The old (empty) server-only map must not be used.
      write("shared.ts", `${MARK}\nexport const shared = 1;`);
      dev.deliver("update", write("product.server-component.ts", BROKEN));

      expect(() => loadIn("client", join(source, "shared.ts"), dev.instance)).toThrow(
        "could not be refreshed",
      );
    });

    it("recovers when the file is fixed: regenerates, reloads, opens the graph again", () => {
      const dev = boot();

      dev.deliver("update", write("product.server-component.ts", BROKEN));
      expect(dev.reloads()).toBe(0);

      const { client } = dev.deliver("update", write("product.server-component.ts", SC("fixed")));

      expect(dev.reloads()).toBe(1);
      expect(client).toEqual([]);
      expect(loadIn("client", join(source, "island.ts"), dev.instance)).toBeNull();
    });

    it("recovers even when the fix is in another file than the broken one", () => {
      const dev = boot();

      dev.deliver("update", write("product.server-component.ts", BROKEN));
      write("product.server-component.ts", SC("fixed"));
      dev.deliver("update", write("island.ts", `export class Island { c = 3 }`));

      expect(dev.reloads()).toBe(1);
    });
  });

  it("starts refusing a module the moment an edit makes it server-only, without a restart", async () => {
    const dev = boot();

    await expect(
      resolveIn("client", "./shared", join(source, "island.ts"), dev.instance),
    ).resolves.toBeNull();

    dev.deliver("update", write("shared.ts", `${MARK}\nexport const shared = 1;`));

    expect(dev.reloads()).toBe(1);
    await expect(
      resolveIn("client", "./shared", join(source, "island.ts"), dev.instance),
    ).rejects.toThrow("Server-only module entered the browser graph: src/app/shared.ts");

    dev.deliver("update", write("shared.ts", `export const shared = 1;`));

    await expect(
      resolveIn("client", "./shared", join(source, "island.ts"), dev.instance),
    ).resolves.toBeNull();
  });

  it("invalidates the client modules of a module whose forbidden status flipped", () => {
    const dev = boot();
    const module = { id: "shared" };

    dev.environments.client.moduleGraph.getModulesByFile.mockImplementation((file: string) =>
      file === join(source, "shared.ts") ? new Set([module]) : undefined,
    );
    dev.deliver("update", write("shared.ts", `${MARK}\nexport const shared = 1;`));

    expect(dev.environments.client.moduleGraph.invalidateModule).toHaveBeenCalledWith(
      module,
      expect.anything(),
    );
  });

  it("does nothing for the plain-SSR control build", () => {
    const instance = strataServerComponents({
      root: dir,
      sourceDir: "src/app",
      generatedDir: "src/generated",
      enabled: false,
    });

    expect(
      (instance.hotUpdate as Hook).call(
        { environment: environment("client") },
        { type: "update", file: join(source, "island.ts"), timestamp: 1, server: {} },
      ),
    ).toBeUndefined();
  });
});
