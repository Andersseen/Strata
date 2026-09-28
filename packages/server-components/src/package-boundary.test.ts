/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ServerComponent } from "./runtime/server-component.js";
import { RUNTIME_PACKAGE } from "./vite/analyze.js";

const packageDir = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
  name: string;
  private?: boolean;
  publishConfig?: unknown;
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
  it("is private and not configured for publishing", () => {
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
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

describe("ServerComponent", () => {
  it("is a marker: it returns the class unchanged and adds nothing to it", () => {
    class Marked {}
    const before = Reflect.ownKeys(Marked);

    expect(ServerComponent()(Marked)).toBe(Marked);
    expect(Reflect.ownKeys(Marked)).toEqual(before);
  });
});
