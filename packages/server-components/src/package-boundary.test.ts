/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ServerComponent } from "./runtime/server-component.js";
import { RUNTIME_PACKAGE } from "./vite/analyze.js";
import { SERVER_ONLY_SPECIFIER } from "./vite/server-only.js";

const packageDir = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
  name: string;
  version: string;
  private?: boolean;
  publishConfig?: unknown;
  exports: Record<string, unknown>;
};

function importsOf(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap((name) => {
      const file = join(dir, name);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

      return source.statements
        .filter(ts.isImportDeclaration)
        .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    });
}

describe("package boundary", () => {
  it("is public with Changesets owning the version and the release workflow owning the dist-tag", () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    // No `tag`: `changeset publish --tag next` (release.yml) is the single source of truth.
    expect(manifest.publishConfig).toEqual({ access: "public" });
  });

  it("exports the server-only assertion entry the plugin recognises", () => {
    expect(SERVER_ONLY_SPECIFIER).toBe(`${manifest.name}/server-only`);
    expect(manifest.exports["./server-only"]).toEqual({
      types: "./dist/server-only/index.d.ts",
      default: "./dist/server-only.js",
    });
  });

  it("keeps the server-only assertion entry empty: no imports, no runtime statements", () => {
    const file = join(packageDir, "src", "server-only", "index.ts");
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

    expect(source.statements.map((statement) => ts.SyntaxKind[statement.kind])).toEqual([
      "ExportDeclaration",
    ]);
    expect(source.statements[0]?.getText(source)).toBe("export {};");
  });

  it("generates surrogates that import this package by its own name", () => {
    expect(RUNTIME_PACKAGE).toBe(manifest.name);
  });

  it("keeps the browser runtime entry free of build tooling and Node built-ins", () => {
    const imports = new Set(importsOf(join(packageDir, "src", "runtime")));

    for (const specifier of imports) {
      expect(specifier === "@angular/core" || /^\.\/[\w-]+\.js$/.test(specifier), specifier).toBe(
        true,
      );
    }
  });
});

describe("no global data registry", () => {
  const runtimeDir = join(packageDir, "src", "runtime");
  const runtimeFiles = readdirSync(runtimeDir).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  /** Process- or window-wide state: where a payload or secret cache could hide. */
  const GLOBAL_STATE = new Set([
    "globalThis",
    "window",
    "self",
    "global",
    "process",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "caches",
  ]);
  /** Module-scope constants that are immutable lookup tables, not registries. */
  const ALLOWED_MODULE_SCOPE_COLLECTIONS = new Set(["FORBIDDEN_KEYS"]);

  function parsed(name: string): ts.SourceFile {
    const file = join(runtimeDir, name);

    return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  }

  it("never reads or writes a global, process-wide or browser-storage object", () => {
    const used = runtimeFiles.flatMap((name) => {
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && GLOBAL_STATE.has(node.text)) {
          const parent = node.parent;
          const isMember =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node);

          if (!isMember) found.push(`${name}: ${node.text}`);
        }

        ts.forEachChild(node, visit);
      };

      visit(parsed(name));

      return found;
    });

    expect(used).toEqual([]);
  });

  it("holds no module-scope mutable collection (no registry, cache or secret store)", () => {
    const collections = runtimeFiles.flatMap((name) =>
      parsed(name)
        .statements.filter(ts.isVariableStatement)
        .flatMap((statement) =>
          statement.declarationList.declarations.flatMap((declaration) => {
            const initializer = declaration.initializer;
            const label = `${name}: ${declaration.name.getText()}`;
            const mutable = !(statement.declarationList.flags & ts.NodeFlags.Const);
            const collection =
              initializer !== undefined &&
              ((ts.isNewExpression(initializer) &&
                /^(?:Weak)?(?:Map|Set)$/.test(initializer.expression.getText())) ||
                ts.isArrayLiteralExpression(initializer) ||
                ts.isObjectLiteralExpression(initializer));

            return (mutable || collection) &&
              !ALLOWED_MODULE_SCOPE_COLLECTIONS.has(declaration.name.getText())
              ? [label]
              : [];
          }),
        ),
    );

    expect(collections).toEqual([]);
  });

  it("does not use Symbol.for, which would share state across realms and bundles", () => {
    expect(
      runtimeFiles.filter((name) =>
        readFileSync(join(runtimeDir, name), "utf8").includes("Symbol.for"),
      ),
    ).toEqual([]);
  });
});

describe("ServerComponent", () => {
  it("is a marker: it returns the class unchanged and adds nothing to it", () => {
    class Marked {}
    const before = Reflect.ownKeys(Marked);

    expect(ServerComponent()(Marked)).toBe(Marked);
    expect(Reflect.ownKeys(Marked)).toEqual(before);
  });
});
