import { describe, expect, it } from "vitest";

import type { BrowserGraphContext } from "./diagnostics.js";
import { serverOnlyOptimizerPlugin } from "./optimizer.js";
import { SERVER_ONLY_SPECIFIER } from "./server-only.js";

const ROOT = "/work/app";
const context: BrowserGraphContext = {
  root: ROOT,
  serverOnly: new Map(),
  surrogateOf: () => undefined,
};
const SECRET = "/work/app/node_modules/@acme/kit/secret.js";
const BARREL = "/work/app/node_modules/@acme/kit/barrel.js";
const ENTRY = "/work/app/node_modules/@acme/kit/chain.js";

/** A Rolldown plugin context whose module info reports `importers` (id → its importers). */
function run(
  imports: ReadonlyArray<readonly [string, string | undefined]>,
  importers: Record<string, string[]> = {},
) {
  const plugin = serverOnlyOptimizerPlugin(context);
  const failures: string[] = [];
  const pluginContext = {
    error(message: string): never {
      failures.push(message);
      throw new Error(message);
    },
    getModuleInfo: (id: string) => (id in importers ? { importers: importers[id] ?? [] } : null),
  };

  plugin.buildStart();
  for (const [source, importer] of imports) expect(plugin.resolveId(source, importer)).toBeNull();

  let thrown: Error | undefined;

  try {
    plugin.buildEnd.call(pluginContext);
  } catch (error) {
    thrown = error as Error;
  }

  return { thrown, failures };
}

describe("serverOnlyOptimizerPlugin", () => {
  it("lets an optimizer run without the assertion finish", () => {
    const { thrown } = run([
      ["./format.js", BARREL],
      ["lodash", BARREL],
    ]);

    expect(thrown).toBeUndefined();
  });

  it("fails the run when a pre-bundled module imports the server-only assertion", () => {
    const { thrown } = run([[SERVER_ONLY_SPECIFIER, SECRET]]);

    expect(thrown?.message).toContain("[strata] Server-only module entered the browser graph");
    expect(thrown?.message).toContain("node_modules/@acme/kit/secret.js");
    expect(thrown?.message).toContain("optimizeDeps");
    expect(thrown?.message).toContain("none known");
  });

  it("reports the importer chain the optimizer knows and never invents one", () => {
    const { thrown } = run([[SERVER_ONLY_SPECIFIER, SECRET]], {
      [SECRET]: [BARREL],
      [BARREL]: [ENTRY],
      [ENTRY]: [],
    });

    expect(thrown?.message).toContain("Imported from: node_modules/@acme/kit/barrel.js");
    expect(thrown?.message).toContain(
      "node_modules/@acme/kit/chain.js → node_modules/@acme/kit/barrel.js → node_modules/@acme/kit/secret.js",
    );
  });

  it("terminates on an importer cycle", () => {
    const { thrown } = run([[SERVER_ONLY_SPECIFIER, SECRET]], {
      [SECRET]: [BARREL],
      [BARREL]: [SECRET],
    });

    expect(thrown?.message).toContain("Imported from: node_modules/@acme/kit/barrel.js");
  });

  it("does not leak absolute machine paths", () => {
    const { thrown } = run([[SERVER_ONLY_SPECIFIER, "/home/someone/project/x/secret.js"]]);

    expect(thrown?.message).not.toContain("/home/someone");
    expect(thrown?.message).toContain("<outside the app root>/secret.js");
  });

  it("does not carry a failure into the next run", () => {
    const plugin = serverOnlyOptimizerPlugin(context);
    const pluginContext = {
      error: (message: string): never => {
        throw new Error(message);
      },
      getModuleInfo: () => null,
    };

    plugin.buildStart();
    plugin.resolveId(SERVER_ONLY_SPECIFIER, SECRET);
    plugin.buildStart();

    expect(() => plugin.buildEnd.call(pluginContext)).not.toThrow();
  });
});
