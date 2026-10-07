import { describe, expect, it } from "vitest";

import {
  EMPTY_GRAPH,
  buildServerComponentGraph,
  decideReload,
  diffGraphs,
  graphChanged,
  syncGeneratedFiles,
} from "./graph.js";
import type { GeneratedFiles, ServerComponentGraph } from "./graph.js";
import { SERVER_ONLY_SPECIFIER } from "./server-only.js";

/**
 * Hot graph regeneration as pure data: snapshot A, an edit, snapshot B. No
 * file system and no Vite; the dev gate (`pnpm test:server-component-dev`)
 * proves the same transitions in a real dev server.
 */

const ROOT = "/app";
const SRC = "/app/src/app";
const GENERATED = "/app/src/generated";
const MARK = `import "${SERVER_ONLY_SPECIFIER}";`;

const serverComponent = (name: string, selector: string, template: string, imports = ""): string =>
  `import { Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
${imports}
@ServerComponent()
@Component({
  selector: ${JSON.stringify(selector)},
  imports: [StrataClientBoundary${imports ? ", Island" : ""}],
  template: \`${template}\`,
})
export class ${name} {}`;

const island = `import { Component } from "@angular/core";
@Component({ selector: "dev-island", template: "<button>go</button>" })
export class Island {}`;

const BASE: Record<string, string> = {
  [`${SRC}/island.ts`]: island,
  [`${SRC}/shared.ts`]: `export const shared = 1;`,
  [`${SRC}/repository.ts`]: `${MARK}\nexport class Repository {}`,
  [`${SRC}/barrel.ts`]: `export { shared } from "./shared";`,
  [`${SRC}/root.ts`]: serverComponent("Root", "dev-root", "<p>A</p>"),
};

function graphOf(overrides: Record<string, string | null> = {}): ServerComponentGraph {
  const sources: Record<string, string> = { ...BASE };

  for (const [path, text] of Object.entries(overrides)) {
    if (text === null) delete sources[path];
    else sources[path] = text;
  }

  return buildServerComponentGraph({
    root: ROOT,
    sourceDir: SRC,
    generatedDir: GENERATED,
    files: Object.keys(sources).sort(),
    readFile: (path) => {
      const text = sources[path];

      if (text === undefined) throw new Error(`ENOENT: ${path}`);

      return text;
    },
  });
}

const SURROGATE = `${GENERATED}/root.ts`;
const withIsland = serverComponent(
  "Root",
  "dev-root",
  `<dev-island [strataClient]="{}" />`,
  `import { Island } from "./island";`,
);

describe("buildServerComponentGraph", () => {
  it("derives sources, surrogates, server-only modules and server-owned files together", () => {
    const graph = graphOf();

    expect([...graph.bySource.keys()]).toEqual([`${SRC}/root.ts`]);
    expect([...graph.bySurrogate.keys()]).toEqual([SURROGATE]);
    expect([...graph.generated.keys()]).toEqual([SURROGATE]);
    expect([...graph.serverOnly.keys()]).toEqual([`${SRC}/repository.ts`]);
    expect([...graph.serverOwnedFiles]).toEqual([`${SRC}/root.ts`]);
  });

  it("throws, producing nothing, when any Server Component fails analysis", () => {
    expect(() =>
      graphOf({
        [`${SRC}/broken.ts`]: serverComponent("Broken", "dev-broken", "<p>@defer {x}</p>"),
      }),
    ).toThrow(/@defer block/);
  });
});

describe("hot regeneration: snapshot A → edit → snapshot B", () => {
  const before = graphOf();

  it("a surrogate is added when a module becomes a Server Component", () => {
    const after = graphOf({
      [`${SRC}/second.ts`]: serverComponent("Second", "dev-second", "<p>2</p>"),
    });
    const diff = diffGraphs(before, after);

    expect(diff.surrogatesAdded).toEqual([`${GENERATED}/second.ts`]);
    expect(diff.surrogatesChanged).toEqual([]);
    expect(diff.surrogatesRemoved).toEqual([]);
    expect(diff.serverOwnedAdded).toEqual([`${SRC}/second.ts`]);
    expect(diff.forbiddenFlipped).toEqual([`${SRC}/second.ts`]);
  });

  it("a surrogate changes when a client boundary is added, and changes back when it is removed", () => {
    const added = graphOf({ [`${SRC}/root.ts`]: withIsland });
    const diff = diffGraphs(before, added);

    expect(diff.surrogatesChanged).toEqual([SURROGATE]);
    expect(added.generated.get(SURROGATE)).toContain('import { Island } from "../app/island";');
    expect(diffGraphs(added, before).surrogatesChanged).toEqual([SURROGATE]);
    expect(diffGraphs(before, graphOf()).surrogatesChanged).toEqual([]);
  });

  it("a surrogate changes when the boundary component changes", () => {
    const other = `import { Component } from "@angular/core";
@Component({ selector: "dev-island", template: "<i>b</i>" })
export class OtherIsland {}`;
    const a = graphOf({ [`${SRC}/root.ts`]: withIsland });
    const b = graphOf({
      [`${SRC}/other.ts`]: other,
      [`${SRC}/root.ts`]: withIsland
        .replace("./island", "./other")
        .replaceAll("Island", "OtherIsland"),
    });

    expect(b.generated.get(SURROGATE)).toContain("OtherIsland");
    expect(b.generated.get(SURROGATE)).not.toMatch(/\bIsland\b/);
    expect(diffGraphs(a, b).surrogatesChanged).toEqual([SURROGATE]);
  });

  it("a surrogate is removed when the Server Component is deleted or stops being one", () => {
    const deleted = diffGraphs(before, graphOf({ [`${SRC}/root.ts`]: null }));
    const demoted = diffGraphs(before, graphOf({ [`${SRC}/root.ts`]: `export class Root {}` }));

    for (const diff of [deleted, demoted]) {
      expect(diff.surrogatesRemoved).toEqual([SURROGATE]);
      expect(diff.serverOwnedRemoved).toEqual([`${SRC}/root.ts`]);
      expect(diff.forbiddenFlipped).toEqual([`${SRC}/root.ts`]);
    }
  });

  it("serverOnly gains a module that starts asserting, and loses it when the assertion goes", () => {
    const marked = graphOf({ [`${SRC}/shared.ts`]: `${MARK}\nexport const shared = 1;` });
    const diff = diffGraphs(before, marked);

    // `barrel.ts` re-exports `shared.ts`, so the taint reaches it too.
    expect(diff.serverOnlyAdded).toEqual([`${SRC}/barrel.ts`, `${SRC}/shared.ts`]);
    expect(diff.forbiddenFlipped).toEqual([`${SRC}/barrel.ts`, `${SRC}/shared.ts`]);
    expect(marked.serverOnly.get(`${SRC}/barrel.ts`)).toMatchObject({
      reason: "server-only-re-export",
      via: `${SRC}/shared.ts`,
    });
    expect(diffGraphs(marked, before).serverOnlyRemoved).toEqual([
      `${SRC}/barrel.ts`,
      `${SRC}/shared.ts`,
    ]);
  });

  it("re-export taint changes when a barrel starts or stops re-exporting a server-only module", () => {
    const tainted = graphOf({ [`${SRC}/barrel.ts`]: `export { Repository } from "./repository";` });
    const diff = diffGraphs(before, tainted);

    expect(diff.serverOnlyAdded).toEqual([`${SRC}/barrel.ts`]);
    expect(diff.serverOnlyRemoved).toEqual([]);
    expect(diffGraphs(tainted, before).serverOnlyRemoved).toEqual([`${SRC}/barrel.ts`]);
  });

  it("a taint that stays but travels through another module is a change, not an addition", () => {
    const direct = graphOf({ [`${SRC}/barrel.ts`]: `export { Repository } from "./repository";` });
    const chained = graphOf({
      [`${SRC}/inner.ts`]: `export { Repository } from "./repository";`,
      [`${SRC}/barrel.ts`]: `export { Repository } from "./inner";`,
    });
    const diff = diffGraphs(direct, chained);

    expect(diff.serverOnlyChanged).toEqual([`${SRC}/barrel.ts`]);
    expect(diff.serverOnlyAdded).toEqual([`${SRC}/inner.ts`]);
  });

  it("the server-owned set follows a nested child and a templateUrl file", () => {
    const parent = serverComponent(
      "Root",
      "dev-root",
      "<dev-child />",
      `import { Child } from "./child";`,
    ).replace("imports: [StrataClientBoundary, Island]", "imports: [StrataClientBoundary, Child]");
    const child = `import { Component } from "@angular/core";
@Component({ selector: "dev-child", templateUrl: "./child.html" })
export class Child {}`;

    // `child.html` is not a TypeScript source, so the reader serves it too.
    const sources: Record<string, string> = {
      ...BASE,
      [`${SRC}/root.ts`]: parent,
      [`${SRC}/child.ts`]: child,
      [`${SRC}/child.html`]: "<p>child</p>",
    };
    const after = buildServerComponentGraph({
      root: ROOT,
      sourceDir: SRC,
      generatedDir: GENERATED,
      files: Object.keys(sources).filter((path) => path.endsWith(".ts")),
      readFile: (path) => sources[path] ?? "",
    });
    const diff = diffGraphs(before, after);

    expect(diff.serverOwnedAdded).toEqual([`${SRC}/child.html`, `${SRC}/child.ts`]);
  });

  it("an identical source set is no change at all", () => {
    expect(graphChanged(diffGraphs(before, graphOf()))).toBe(false);
  });

  it("diffing against the empty graph reports everything as added", () => {
    const diff = diffGraphs(EMPTY_GRAPH, before);

    expect(diff.surrogatesAdded).toEqual([SURROGATE]);
    expect(diff.serverOnlyAdded).toEqual([`${SRC}/repository.ts`]);
  });

  it("analysis failure produces no graph: the committed snapshot is untouched by construction", () => {
    const committed = graphOf();
    const snapshot = JSON.stringify([...committed.generated]);

    expect(() =>
      graphOf({
        [`${SRC}/root.ts`]: serverComponent("Root", "dev-root", `<button (click)="x()">x</button>`),
      }),
    ).toThrow(/Interactive binding/);
    expect(JSON.stringify([...committed.generated])).toBe(snapshot);
  });
});

describe("decideReload: which edits need a new server render", () => {
  const before = graphOf();
  const decide = (
    file: string,
    after: ServerComponentGraph,
    recovered = false,
  ): ReturnType<typeof decideReload> =>
    decideReload(file, before, after, diffGraphs(before, after), recovered);

  it("reloads when a server-owned file changes even though nothing in the graph differs", () => {
    const edited = graphOf({ [`${SRC}/root.ts`]: serverComponent("Root", "dev-root", "<p>B</p>") });

    expect(diffGraphs(before, edited).surrogatesChanged).toEqual([]);
    expect(decide(`${SRC}/root.ts`, edited)).toMatchObject({ reload: true });
  });

  it("reloads when a server-only module changes", () => {
    const edited = graphOf({
      [`${SRC}/repository.ts`]: `${MARK}\nexport class Repository { a = 1 }`,
    });

    expect(decide(`${SRC}/repository.ts`, edited)).toMatchObject({ reload: true });
  });

  it("does not reload for a client island edit that leaves the graph identical", () => {
    const edited = graphOf({ [`${SRC}/island.ts`]: island.replace("go", "label B") });

    expect(decide(`${SRC}/island.ts`, edited)).toEqual({ reload: false, reason: "" });
    expect(decide(`${SRC}/shared.ts`, graphOf())).toEqual({ reload: false, reason: "" });
  });

  it("reloads when a client edit changes the graph: a surrogate or the server-only set", () => {
    const rebound = graphOf({ [`${SRC}/root.ts`]: withIsland });
    const marked = graphOf({ [`${SRC}/shared.ts`]: `${MARK}\nexport const shared = 1;` });

    expect(decide(`${SRC}/island.ts`, rebound)).toMatchObject({ reload: true });
    expect(decide(`${SRC}/shared.ts`, marked)).toMatchObject({ reload: true });
  });

  it("reloads when the previous refresh had failed, whatever file changed", () => {
    expect(decide(`${SRC}/island.ts`, graphOf(), true)).toMatchObject({ reload: true });
  });
});

/** An in-memory `GeneratedFiles` that records what was written and removed. */
function memoryFiles(initial: Record<string, string>): GeneratedFiles & {
  readonly disk: Map<string, string>;
  readonly writes: string[];
  readonly removes: string[];
} {
  const disk = new Map(Object.entries(initial));
  const writes: string[] = [];
  const removes: string[] = [];

  return {
    disk,
    writes,
    removes,
    list: (dir) => [...disk.keys()].filter((path) => path.startsWith(`${dir}/`)),
    read: (path) => disk.get(path),
    write(path, text) {
      writes.push(path);
      disk.set(path, text);
    },
    remove(path) {
      removes.push(path);
      disk.delete(path);
    },
    pruneEmpty: () => undefined,
  };
}

describe("syncGeneratedFiles", () => {
  it("creates a missing surrogate", () => {
    const files = memoryFiles({});
    const result = syncGeneratedFiles(GENERATED, new Map([[`${GENERATED}/a.ts`, "A"]]), files);

    expect(result).toEqual({ written: [`${GENERATED}/a.ts`], removed: [] });
    expect(files.disk.get(`${GENERATED}/a.ts`)).toBe("A");
  });

  it("does not rewrite an unchanged surrogate", () => {
    const files = memoryFiles({ [`${GENERATED}/a.ts`]: "A" });
    const result = syncGeneratedFiles(GENERATED, new Map([[`${GENERATED}/a.ts`, "A"]]), files);

    expect(result).toEqual({ written: [], removed: [] });
    expect(files.writes).toEqual([]);
  });

  it("rewrites only the surrogates whose content changed", () => {
    const files = memoryFiles({ [`${GENERATED}/a.ts`]: "A", [`${GENERATED}/b.ts`]: "B" });
    const result = syncGeneratedFiles(
      GENERATED,
      new Map([
        [`${GENERATED}/a.ts`, "A"],
        [`${GENERATED}/b.ts`, "B2"],
      ]),
      files,
    );

    expect(result.written).toEqual([`${GENERATED}/b.ts`]);
    expect(files.writes).toEqual([`${GENERATED}/b.ts`]);
  });

  it("deletes a surrogate that is no longer wanted, and anything else under the directory", () => {
    const files = memoryFiles({
      [`${GENERATED}/a.ts`]: "A",
      [`${GENERATED}/nested/stale.ts`]: "S",
      [`${GENERATED}/notes.txt`]: "leftover",
    });
    const result = syncGeneratedFiles(GENERATED, new Map([[`${GENERATED}/a.ts`, "A"]]), files);

    expect(result.removed).toEqual([`${GENERATED}/nested/stale.ts`, `${GENERATED}/notes.txt`]);
    expect([...files.disk.keys()]).toEqual([`${GENERATED}/a.ts`]);
  });

  it("is idempotent: a second sync of the same graph touches nothing", () => {
    const files = memoryFiles({ [`${GENERATED}/gone.ts`]: "G" });
    const desired = new Map([[`${GENERATED}/a.ts`, "A"]]);

    syncGeneratedFiles(GENERATED, desired, files);
    files.writes.length = 0;
    files.removes.length = 0;

    expect(syncGeneratedFiles(GENERATED, desired, files)).toEqual({ written: [], removed: [] });
    expect(files.writes).toEqual([]);
    expect(files.removes).toEqual([]);
  });
});
