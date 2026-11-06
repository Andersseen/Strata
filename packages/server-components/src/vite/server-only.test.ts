import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { stripQuery } from "./module-id.js";
import {
  SERVER_ONLY_SPECIFIER,
  createInstalledFacts,
  emittedServerOnly,
  findServerOnlyChain,
  reExportChain,
  scanServerOnlyModules,
  serverOnlyFacts,
} from "./server-only.js";

/** Server-only assertions and re-export taint over a small virtual app. */

const DIR = "/app/src/app";
const MARK = `import "${SERVER_ONLY_SPECIFIER}";`;

function scan(sources: Record<string, string>) {
  const files = Object.keys(sources)
    .map((name) => `${DIR}/${name}`)
    .sort();
  const forbidden = scanServerOnlyModules(files, (file) => {
    const text = sources[file.slice(DIR.length + 1)];

    if (text === undefined) throw new Error(`ENOENT: ${file}`);

    return text;
  });

  return {
    forbidden,
    names: [...forbidden.keys()].map((file) => file.slice(DIR.length + 1)).sort(),
  };
}

describe("serverOnlyFacts", () => {
  it("detects the real side-effect import", () => {
    expect(serverOnlyFacts("x.ts", `${MARK}\nexport class Repo {}`).asserted).toBe(true);
    expect(serverOnlyFacts("x.ts", `import '${SERVER_ONLY_SPECIFIER}';`).asserted).toBe(true);
  });

  it("ignores the marker text in a comment", () => {
    const text = `// ${MARK}\n/* ${MARK} */\n/** ${MARK} */\nexport class Repo {}`;

    expect(serverOnlyFacts("x.ts", text).asserted).toBe(false);
  });

  it("ignores the marker text in a string or a template literal", () => {
    const text = `export const docs = "${MARK.replaceAll('"', "'")}";\nexport const t = \`${MARK}\`;`;

    expect(serverOnlyFacts("x.ts", text).asserted).toBe(false);
  });

  it("only accepts the exact side-effect form of the exact specifier", () => {
    for (const text of [
      `import marker from "${SERVER_ONLY_SPECIFIER}";`,
      `import * as marker from "${SERVER_ONLY_SPECIFIER}";`,
      `import "${SERVER_ONLY_SPECIFIER}.js";`,
      `import "@strata-sc/server-components";`,
      `export * from "${SERVER_ONLY_SPECIFIER}";`,
      `function f() { return import("${SERVER_ONLY_SPECIFIER}"); }`,
    ]) {
      expect(serverOnlyFacts("x.ts", text).asserted, text).toBe(false);
    }
  });

  it("collects runtime re-exports, not type-only ones or imports", () => {
    const text = [
      `import { a } from "./imported";`,
      `export * from "./star";`,
      `export { B } from "./named";`,
      `export * as C from "./namespace";`,
      `export { type D } from "./inline-type";`,
      `export { type F, G } from "./mixed";`,
      `export {} from "./side-effect";`,
      `export type { E } from "./type-only";`,
      `export { a };`,
    ].join("\n");

    expect(serverOnlyFacts("x.ts", text).reExports).toEqual([
      "./star",
      "./named",
      "./namespace",
      "./mixed",
      "./side-effect",
    ]);
  });
});

describe("scanServerOnlyModules", () => {
  it("marks only modules that assert server-only", () => {
    const { forbidden, names } = scan({
      "repository.ts": `${MARK}\nexport class Repository {}`,
      "client.ts": `export class Client {}`,
    });

    expect(names).toEqual(["repository.ts"]);
    expect(forbidden.get(`${DIR}/repository.ts`)).toEqual({
      file: `${DIR}/repository.ts`,
      reason: "server-only-assertion",
    });
  });

  it("does not propagate through a normal import", () => {
    const { names } = scan({
      "repository.ts": `${MARK}\nimport { secret } from "./secret";\nexport const r = secret;`,
      "secret.ts": `export const secret = "s";`,
      "consumer.ts": `import { r } from "./repository";\nexport const c = r;`,
    });

    expect(names).toEqual(["repository.ts"]);
  });

  it("keeps a dependency shared by a server-only module and a client module unmarked", () => {
    const { names } = scan({
      "repository.ts": `${MARK}\nimport { format } from "./shared-format";\nexport const r = format("x");`,
      "island.ts": `import { format } from "./shared-format";\nexport const i = format("y");`,
      "shared-format.ts": `export function format(value: string) { return value; }`,
    });

    expect(names).toEqual(["repository.ts"]);
  });

  it("propagates through a direct named re-export", () => {
    const { forbidden, names } = scan({
      "repository.ts": `${MARK}\nexport class Repository {}`,
      "index.ts": `export { Repository } from "./repository";`,
    });

    expect(names).toEqual(["index.ts", "repository.ts"]);
    expect(forbidden.get(`${DIR}/index.ts`)).toEqual({
      file: `${DIR}/index.ts`,
      reason: "server-only-re-export",
      via: `${DIR}/repository.ts`,
    });
  });

  it("propagates through export *", () => {
    expect(
      scan({
        "repository.ts": `${MARK}\nexport class Repository {}`,
        "barrel.ts": `export * from "./repository";`,
      }).names,
    ).toEqual(["barrel.ts", "repository.ts"]);
  });

  it("propagates through export * as", () => {
    expect(
      scan({
        "repository.ts": `${MARK}\nexport class Repository {}`,
        "barrel.ts": `export * as data from "./repository";`,
      }).names,
    ).toEqual(["barrel.ts", "repository.ts"]);
  });

  it("does not propagate through a type-only re-export, which loads nothing", () => {
    expect(
      scan({
        "repository.ts": `${MARK}\nexport interface Row { id: string }`,
        "types.ts": `export type { Row } from "./repository";`,
      }).names,
    ).toEqual(["repository.ts"]);
  });

  it("resolves directory, .ts and .js specifiers to scanned modules", () => {
    expect(
      scan({
        "server/repository.ts": `${MARK}\nexport class Repository {}`,
        "server/index.ts": `export * from "./repository.js";`,
        "barrel-ts.ts": `export * from "./server/repository.ts";`,
        "barrel-dir.ts": `export * from "./server";`,
      }).names,
    ).toEqual(["barrel-dir.ts", "barrel-ts.ts", "server/index.ts", "server/repository.ts"]);
  });

  it("propagates through chained barrels, with the chain back to the assertion", () => {
    const { forbidden, names } = scan({
      "repository.ts": `${MARK}\nexport class Repository {}`,
      "barrel-a.ts": `export { Repository } from "./repository";`,
      "barrel-b.ts": `export * from "./barrel-a";`,
      "barrel-c.ts": `export * as all from "./barrel-b";`,
      "unrelated.ts": `export * from "./shared";`,
      "shared.ts": `export const x = 1;`,
    });

    expect(names).toEqual(["barrel-a.ts", "barrel-b.ts", "barrel-c.ts", "repository.ts"]);
    expect(
      reExportChain(forbidden.get(`${DIR}/barrel-c.ts`)!, forbidden).map((file) =>
        file.slice(DIR.length + 1),
      ),
    ).toEqual(["barrel-c.ts", "barrel-b.ts", "barrel-a.ts", "repository.ts"]);
  });

  it("terminates on a re-export cycle and taints every barrel on it", () => {
    const { names } = scan({
      "a.ts": `export * from "./b";`,
      "b.ts": `export * from "./a";\nexport * from "./c";`,
      "c.ts": `${MARK}\nexport const secret = 1;`,
    });

    expect(names).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("leaves a re-export cycle without a server-only module unmarked", () => {
    expect(scan({ "a.ts": `export * from "./b";`, "b.ts": `export * from "./a";` }).names).toEqual(
      [],
    );
  });

  it("does not use directory names, file names or secret-looking content", () => {
    expect(
      scan({
        "server/db.server.ts": `export const DATABASE_URL = "postgres://"; export const API_KEY = "k";`,
      }).names,
    ).toEqual([]);
  });
});

describe("stripQuery", () => {
  it("maps every query form to the underlying module", () => {
    for (const id of ["/a/x.ts", "/a/x.ts?raw", "/a/x.ts?url", "/a/x.ts?import&raw", "/a/x.ts?"]) {
      expect(stripQuery(id)).toBe("/a/x.ts");
    }
  });
});

describe("findServerOnlyChain", () => {
  /** A package as `{ file: source }`, resolved by exact relative name. */
  const walk = (files: Record<string, string>, entry: string, limit?: number) =>
    findServerOnlyChain(
      entry,
      (file) => (file in files ? serverOnlyFacts(file, files[file] as string) : undefined),
      (specifier) => Promise.resolve(specifier in files ? specifier : undefined),
      limit,
    );

  it("names the entry alone when it asserts", async () => {
    await expect(walk({ a: MARK }, "a")).resolves.toEqual({ chain: ["a"], truncated: false });
  });

  it("follows wildcard, named and namespace re-exports to the assertion", async () => {
    const files = {
      star: `export * from "named";`,
      named: `export { x } from "namespace";`,
      namespace: `export * as y from "secret";`,
      secret: MARK,
    };

    await expect(walk(files, "star")).resolves.toEqual({
      chain: ["star", "named", "namespace", "secret"],
      truncated: false,
    });
  });

  it("reports a shortest chain, in declaration order", async () => {
    const files = {
      entry: `export * from "long"; export * from "second"; export * from "first";`,
      long: `export * from "longer";`,
      longer: `export * from "secret";`,
      first: `export * from "secret";`,
      second: `export * from "secret";`,
      secret: MARK,
    };

    await expect(walk(files, "entry")).resolves.toEqual({
      chain: ["entry", "second", "secret"],
      truncated: false,
    });
  });

  it("does not follow an ordinary import, a type-only re-export or an unresolved specifier", async () => {
    const files = {
      entry: [
        `import "secret";`,
        `import { a } from "secret";`,
        `export type { T } from "secret";`,
        `export { type U } from "secret";`,
        `export * from "missing";`,
      ].join("\n"),
      secret: MARK,
    };

    await expect(walk(files, "entry")).resolves.toEqual({ truncated: false });
  });

  it("terminates on cycles and still finds what lies behind them", async () => {
    const cycle = { a: `export * from "b";`, b: `export * from "a"; export * from "c";` };

    await expect(walk({ ...cycle, c: `export const safe = 1;` }, "a")).resolves.toEqual({
      truncated: false,
    });
    await expect(walk({ ...cycle, c: MARK }, "a")).resolves.toEqual({
      chain: ["a", "b", "c"],
      truncated: false,
    });
    await expect(walk({ a: `export * from "a";` }, "a")).resolves.toEqual({ truncated: false });
  });

  it("reports a walk it stopped at its limit, without a verdict", async () => {
    const files = { a: `export * from "b";`, b: `export * from "c";`, c: MARK };

    await expect(walk(files, "a", 2)).resolves.toEqual({ truncated: true });
  });
});

describe("createInstalledFacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-installed-facts-"));
  const write = (name: string, text: string): string => {
    const file = join(dir, name);

    writeFileSync(file, text);

    return file;
  };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads assertions and re-exports from every script extension a package ships", () => {
    const facts = createInstalledFacts();

    for (const name of ["a.js", "a.mjs", "a.cjs", "a.ts", "a.mts"]) {
      expect(facts(write(name, MARK))?.asserted, name).toBe(true);
    }
    expect(facts(write("b.mjs", `export*from"./c.mjs";`))?.reExports).toEqual(["./c.mjs"]);
  });

  it("has nothing to say about declarations, other files and missing paths", () => {
    const facts = createInstalledFacts();

    expect(facts(write("types.d.ts", MARK))).toBeUndefined();
    expect(facts(write("style.css", MARK))).toBeUndefined();
    expect(facts(join(dir, "missing.js"))).toBeUndefined();
  });

  it("sees a changed file, and skips the parse of one with nothing to find", () => {
    const facts = createInstalledFacts();
    const file = write("edited.js", `export const safe = 1;`);

    expect(facts(file)).toEqual({ asserted: false, reExports: [] });
    write("edited.js", MARK);
    expect(facts(file)?.asserted).toBe(true);
  });

  it("does not take the specifier in a comment or a string for the assertion", () => {
    const facts = createInstalledFacts();

    expect(facts(write("doc.js", `// ${MARK}\nexport const a = ${JSON.stringify(MARK)};`))).toEqual(
      { asserted: false, reExports: [] },
    );
  });
});

describe("emittedServerOnly", () => {
  const base64 = (text: string): string => Buffer.from(text).toString("base64");
  const chunk = (code: string) => ({ type: "chunk", fileName: "assets/c.js", code }) as const;
  const asset = (fileName: string, source: string | Uint8Array, originalFileNames?: string[]) =>
    ({ type: "asset", fileName, source, ...(originalFileNames && { originalFileNames }) }) as const;

  it("finds a copied module, as text or as bytes, under its original name too", () => {
    expect(emittedServerOnly(asset("assets/s.js", MARK))).toBe("assets/s.js");
    expect(emittedServerOnly(asset("assets/s.ts", new TextEncoder().encode(MARK)))).toBe(
      "assets/s.ts",
    );
    expect(emittedServerOnly(asset("assets/s.bin", MARK, ["node_modules/p/s.js"]))).toBe(
      "assets/s.bin",
    );
  });

  it("finds a module inlined as a data URL, whatever its media type", () => {
    for (const type of ["text/javascript", "video/mp2t", "application/octet-stream"]) {
      expect(
        emittedServerOnly(chunk(`new URL("data:${type};base64,${base64(MARK)}", import.meta.url)`)),
      ).toBe("assets/c.js");
    }
  });

  it("does not refuse a page that displays the assertion, or an unrelated file", () => {
    expect(emittedServerOnly(chunk(`const sample = ${JSON.stringify(MARK)};`))).toBeUndefined();
    expect(emittedServerOnly(asset("assets/guide.md", MARK))).toBeUndefined();
    expect(emittedServerOnly(asset("assets/safe.js", `export const a = 1;`))).toBeUndefined();
    expect(
      emittedServerOnly(chunk(`"data:image/png;base64,${base64("plain bytes")}"`)),
    ).toBeUndefined();
  });
});
