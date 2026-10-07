/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import ts from "typescript";

import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";

import {
  BROWSER_DIRS,
  MARKERS,
  check,
  dirGraph,
  distDir,
  fixtureDir,
  graphFilesWith,
  section,
} from "./harness.ts";
import type { OutputGraph } from "./harness.ts";

/**
 * Server-only modules (`import "@strata-sc/server-components/server-only"`)
 * against the Analog fixture's production builds. Two fixture modules assert
 * server-only: `product-repository.ts` and the module it imports,
 * `server-secret.ts`, which holds a synthetic canary. Both are used by the
 * `ProductDetailsComponent` Server Component. `shared-format.ts` is imported
 * by the repository and by the `AddToCart` island: it is shared, unmarked.
 *
 * The illegal shapes are temporary modules written into the fixture (and
 * always removed): a page renders a temporary Server Component whose
 * `[strataClient]` island reaches a server-only module.
 */

const REPOSITORY = "src/app/server-component/product-repository.ts";
const SECRET = "src/app/server-component/server-secret.ts";
const SHARED = "src/app/server-component/shared-format.ts";
/** The assertion entry of the package; never a browser dependency. */
const ASSERTION_ENTRY = "packages/server-components/dist/server-only.js";
export const SHARED_MARKER = "STRATA_SHARED_FORMAT_MARKER";

const all = (results: readonly boolean[]): boolean => results.every(Boolean);

/**
 * Whether `file` declares the server-only assertion as a real top-level
 * side-effect import (read from its AST, as the plugin does), not as text.
 */
export function declaresServerOnly(file: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      !statement.importClause &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@strata-sc/server-components/server-only",
  );
}

/** Every source module bundled into the graph's JavaScript, from its source maps. */
export function bundledSources(graph: OutputGraph): string[] {
  return graph.files
    .filter((file) => /\.m?js\.map$/.test(file))
    .flatMap(
      (file) =>
        (
          JSON.parse(readFileSync(join(graph.root ?? distDir, file), "utf8")) as {
            sources?: string[];
          }
        ).sources ?? [],
    );
}

const bundles = (sources: readonly string[], module: string): boolean =>
  sources.some((source) => source.endsWith(module));

/** Control build (plugin off): the canary and the marked modules MUST reach the browser. */
export function checkServerOnlyControl(): boolean {
  section("Control: the scans can see the server-only modules when protection is off");

  const browser = dirGraph("dist/client, dist/analog/public", BROWSER_DIRS);
  const sources = bundledSources(browser);

  return all([
    check(
      `control leaks ${MARKERS.serverOnlyCanary} into browser JS`,
      graphFilesWith(browser, MARKERS.serverOnlyCanary).some((file) => file.endsWith(".js")),
    ),
    check(`control bundles ${REPOSITORY} for the browser`, bundles(sources, REPOSITORY)),
    check(`control bundles ${SECRET} for the browser`, bundles(sources, SECRET)),
  ]);
}

/** Production build: marked modules server-side only, the shared module in both graphs. */
export function checkServerOnlyGraphs(browser: OutputGraph, server: OutputGraph): boolean {
  section(`Server-only modules: browser (${browser.label}) vs server (${server.label})`);

  const browserSources = bundledSources(browser);
  const serverSources = bundledSources(server);
  const canaryInBrowser = graphFilesWith(browser, MARKERS.serverOnlyCanary);

  console.log(
    `browser source maps list ${browserSources.length} modules; server source maps ${serverSources.length}`,
  );

  return all([
    check("browser source maps list the bundled modules", browserSources.length > 0),
    check(
      `${MARKERS.serverOnlyCanary} absent from every browser file (JS, assets, source maps)`,
      canaryInBrowser.length === 0,
      canaryInBrowser.join(", "),
    ),
    check(
      `${MARKERS.serverOnlyCanary} present in the server output (${graphFilesWith(server, MARKERS.serverOnlyCanary).join(", ")})`,
      graphFilesWith(server, MARKERS.serverOnlyCanary).length > 0,
    ),
    ...[REPOSITORY, SECRET].flatMap((module) => [
      check(`${module} not bundled for the browser`, !bundles(browserSources, module)),
      check(`${module} bundled for the server`, bundles(serverSources, module)),
    ]),
    check(
      `assertion entry ${ASSERTION_ENTRY} not bundled for the browser`,
      !bundles(browserSources, ASSERTION_ENTRY),
    ),
    check(
      `shared module ${SHARED} bundled for the browser (island) and the server (repository)`,
      bundles(browserSources, SHARED) && bundles(serverSources, SHARED),
    ),
    check(
      `${SHARED_MARKER} present in browser JS and in the server output`,
      graphFilesWith(browser, SHARED_MARKER).some((file) => file.endsWith(".js")) &&
        graphFilesWith(server, SHARED_MARKER).length > 0,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Fail closed: illegal browser imports of server-only modules

const LEAK_DIR = "src/app/server-only-leak";
const LEAK_PAGE = "src/app/pages/server-only-leak.page.ts";
const ISLAND = `${LEAK_DIR}/leak-island.component.ts`;
const LAZY = `${LEAK_DIR}/leak-lazy.component.ts`;
const BARREL_A = `${LEAK_DIR}/barrel-a.ts`;
const BARREL_B = `${LEAK_DIR}/barrel-b.ts`;
const ASSERTION = 'import "@strata-sc/server-components/server-only";';

/** The temporary island; `body` is its imports, template and class members. */
function island(imports: string, template: string, members: string, extra = ""): string {
  return `import { ChangeDetectionStrategy, Component } from "@angular/core";
${imports}

@Component({
  selector: "server-only-leak-island",
  changeDetection: ChangeDetectionStrategy.OnPush,
  ${extra}
  template: \`${template}\`,
})
export class ServerOnlyLeakIslandComponent {
${members}
}
`;
}

const SCAFFOLD: Record<string, string> = {
  [LEAK_PAGE]: `import { Component } from "@angular/core";

import { ServerOnlyLeakServerComponent } from "../server-only-leak/leak.server-component";

@Component({
  selector: "app-server-only-leak-page",
  imports: [ServerOnlyLeakServerComponent],
  template: "<server-only-leak />",
})
export default class ServerOnlyLeakPage {}
`,
  [`${LEAK_DIR}/leak.server-component.ts`]: `import { Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { ProductRepository } from "../server-component/product-repository";

import { ServerOnlyLeakIslandComponent } from "./leak-island.component";

// Legal: a Server Component may use a server-only repository.
@ServerComponent()
@Component({
  selector: "server-only-leak",
  imports: [ServerOnlyLeakIslandComponent, StrataClientBoundary],
  template: \`<p>{{ name }}</p><server-only-leak-island [strataClient]="{}" />\`,
})
export class ServerOnlyLeakServerComponent {
  protected readonly name = new ProductRepository().findById("7").name;
}
`,
  [BARREL_A]: `export { ProductRepository } from "../server-component/product-repository";\n`,
  [BARREL_B]: `export * from "./barrel-a";\n`,
};

interface IllegalShape {
  readonly shape: string;
  readonly files: Record<string, string>;
  /** The forbidden module as the diagnostic names it (app-relative, with any query). */
  readonly module: string;
  readonly importer: string;
  /** Text the `Reason:` line must contain. */
  readonly reason: string;
}

const REPOSITORY_FROM_LEAK = "../server-component/product-repository";

const ILLEGAL: readonly IllegalShape[] = [
  {
    shape: "client island → direct import",
    files: {
      [ISLAND]: island(
        `import { ProductRepository } from "${REPOSITORY_FROM_LEAK}";`,
        "<p>{{ name }}</p>",
        `  protected readonly name = new ProductRepository().findById("1").name;`,
      ),
    },
    module: REPOSITORY,
    importer: ISLAND,
    reason: `the module declares \`${ASSERTION}\``,
  },
  {
    shape: "client island → dynamic import()",
    files: {
      [ISLAND]: island(
        "",
        `<button type="button" (click)="load()">Load</button>`,
        `  protected async load(): Promise<void> {
    const { ProductRepository } = await import("${REPOSITORY_FROM_LEAK}");

    console.log(new ProductRepository().findById("1"));
  }`,
      ),
    },
    module: REPOSITORY,
    importer: ISLAND,
    reason: `the module declares \`${ASSERTION}\``,
  },
  {
    shape: "client island → barrel → server-only",
    files: {
      [ISLAND]: island(
        `import { ProductRepository } from "./barrel-a";`,
        "<p>{{ name }}</p>",
        `  protected readonly name = new ProductRepository().findById("1").name;`,
      ),
    },
    module: BARREL_A,
    importer: ISLAND,
    reason: `it re-exports a server-only module: ${BARREL_A} → ${REPOSITORY}`,
  },
  {
    shape: "client island → barrel B → barrel A → server-only",
    files: {
      [ISLAND]: island(
        `import { ProductRepository } from "./barrel-b";`,
        "<p>{{ name }}</p>",
        `  protected readonly name = new ProductRepository().findById("1").name;`,
      ),
    },
    module: BARREL_B,
    importer: ISLAND,
    reason: `it re-exports a server-only module: ${BARREL_B} → ${BARREL_A} → ${REPOSITORY}`,
  },
  {
    shape: "client island → server-only?raw",
    files: {
      [ISLAND]: island(
        `import source from "../server-component/server-secret.ts?raw";`,
        "<p>{{ length }}</p>",
        "  protected readonly length = source.length;",
      ),
    },
    module: `${SECRET}?raw`,
    importer: ISLAND,
    reason: `the module declares \`${ASSERTION}\``,
  },
  {
    shape: "client island → server-only?url",
    files: {
      [ISLAND]: island(
        // A namespace import: the server build (legal for it) reports a missing
        // default export of `?url` on a TypeScript module as an error for a
        // default import, racing the client build's Strata diagnostic.
        `import * as asset from "../server-component/server-secret.ts?url";`,
        "<p>{{ url }}</p>",
        "  protected readonly url = String(asset.default);",
      ),
    },
    module: `${SECRET}?url`,
    importer: ISLAND,
    reason: `the module declares \`${ASSERTION}\``,
  },
  {
    shape: "client island → @defer lazy component → dynamic import(server-only)",
    files: {
      [ISLAND]: island(
        `import { ServerOnlyLeakLazyComponent } from "./leak-lazy.component";`,
        `@defer (on interaction) { <server-only-leak-lazy /> } @placeholder { <button type="button">Load</button> }`,
        "",
        "imports: [ServerOnlyLeakLazyComponent],",
      ),
      [LAZY]: `import { ChangeDetectionStrategy, Component } from "@angular/core";
import type { OnInit } from "@angular/core";

@Component({
  selector: "server-only-leak-lazy",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: "<p>lazy</p>",
})
export class ServerOnlyLeakLazyComponent implements OnInit {
  async ngOnInit(): Promise<void> {
    const { readServerSecret } = await import("../server-component/server-secret");

    console.log(readServerSecret());
  }
}
`,
    },
    module: SECRET,
    importer: LAZY,
    reason: `the module declares \`${ASSERTION}\``,
  },
];

function removeLeak(): void {
  rmSync(join(fixtureDir, LEAK_DIR), { recursive: true, force: true });
  rmSync(join(fixtureDir, LEAK_PAGE), { force: true });
}

function write(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(fixtureDir, path)), { recursive: true });
    writeFileSync(join(fixtureDir, path), text);
  }
}

/** Server-only leaks the browser could receive from a (partial) failed build. */
function leakedAfterFailure(): string[] {
  const dirs = BROWSER_DIRS.filter((dir) => existsSync(join(distDir, dir)));
  const graph = dirGraph("browser output", dirs);

  return [MARKERS.serverOnlyCanary, MARKERS.repository].flatMap((marker) =>
    graphFilesWith(graph, marker),
  );
}

/**
 * Each illegal shape is a real production build that must exit non-zero
 * with the Strata diagnostic, before any browser output carries the
 * server-only module. A legal control (the same temporary Server Component,
 * whose island imports nothing server-only) must build, so the failures are
 * caused by the illegal import and nothing else.
 */
export function checkServerOnlyFailsClosed(): boolean {
  section("Fail closed: illegal browser imports of server-only modules fail the production build");

  const results: boolean[] = [];
  const build = () => {
    rmSync(distDir, { recursive: true, force: true });

    const result = run("pnpm", ["exec", "vite", "build"], { cwd: fixtureDir });

    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  };

  try {
    write(SCAFFOLD);
    write({
      [ISLAND]: island(
        `import { formatShared } from "../server-component/shared-format";`,
        "<p>{{ label }}</p>",
        `  protected readonly label = formatShared("legal");`,
      ),
    });

    const legal = build();

    results.push(
      check(
        "legal control: Server Component → server-only repository, island → shared module, build exits 0",
        legal.status === 0,
        legal.output.slice(-2_000),
      ),
    );

    for (const { shape, files, module, importer, reason } of ILLEGAL) {
      rmSync(join(fixtureDir, LAZY), { force: true });
      write(files);

      const { status, output } = build();
      const start = output.indexOf("[strata] Server-only module entered the browser graph:");
      const diagnostic = start === -1 ? "" : output.slice(start).split("\n").slice(0, 4).join("\n");

      console.log(`\n${shape}:\n${diagnostic || output.slice(0, 3_000)}`);
      results.push(
        check(`${shape}: build exits non-zero`, status !== 0, String(status)),
        check(
          `${shape}: diagnostic names the module, the importer, the reason and the fix`,
          diagnostic.startsWith(
            `[strata] Server-only module entered the browser graph: ${module}\nImported from: ${importer}\nReason: ${reason}`,
          ) && /\n(?:Move|Import) the /.test(diagnostic),
          diagnostic,
        ),
        check(
          `${shape}: no browser output carries the server-only module`,
          leakedAfterFailure().length === 0,
          leakedAfterFailure().join(", "),
        ),
      );
    }
  } finally {
    removeLeak();
  }

  results.push(
    check(
      "no temporary leak module left in the fixture",
      !existsSync(join(fixtureDir, LEAK_DIR)) &&
        !listFiles(join(fixtureDir, "src", "app", "pages")).some((f) => f.includes("leak")),
    ),
  );

  return all(results);
}
