/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import ts from "typescript";

import { RUNTIME_PACKAGE } from "./analyze.js";
import type { ReadFile } from "./analyze.js";
import { createModuleResolver } from "./resolve.js";
import type { ModuleResolver } from "./resolve.js";

/** The side-effect import that marks a module as never allowed in a browser graph. */
export const SERVER_ONLY_SPECIFIER = `${RUNTIME_PACKAGE}/server-only`;

/**
 * A module the client environment must never load. Private to the plugin.
 *
 * - `server-only-assertion`: it declares `import "<SERVER_ONLY_SPECIFIER>";`.
 * - `server-only-re-export`: it re-exports (`export … from`) a server-only
 *   module, directly or through other barrels; `via` is the module it re-exports.
 */
export interface ServerOnlyModule {
  readonly file: string;
  readonly reason: "server-only-assertion" | "server-only-re-export";
  readonly via?: string;
}

/** What one module says about server-only ownership, read from its AST. */
export interface ServerOnlyFacts {
  /** It contains the exact side-effect import of {@link SERVER_ONLY_SPECIFIER}. */
  readonly asserted: boolean;
  /** Specifiers of its runtime re-exports: `export * from`, `export { X } from`, `export * as X from`. */
  readonly reExports: readonly string[];
}

/**
 * Reads the assertion and the re-export specifiers from a module's top-level
 * statements. Only real declarations count: the specifier in a comment, a
 * string or a template literal is not an import. `export type { … } from`
 * is erased by TypeScript and loads nothing, so it is not a re-export here.
 */
export function serverOnlyFacts(file: string, text: string): ServerOnlyFacts {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  let asserted = false;
  const reExports: string[] = [];

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === SERVER_ONLY_SPECIFIER
    ) {
      asserted = true;
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      reExports.push(statement.moduleSpecifier.text);
    }
  }

  return { asserted, reExports };
}

/**
 * The build-scoped set of server-only modules among `files` (absolute paths
 * of the app's TypeScript sources).
 *
 *   1. every module that asserts server-only is forbidden in the browser;
 *   2. every module that re-exports a forbidden module is forbidden too,
 *      propagated upward through re-export edges only, to a fixpoint.
 *
 * A re-export specifier names its target through `resolver`: relative paths
 * by default, plus Vite aliases and tsconfig `paths` when the plugin passes a
 * resolver that knows them. A specifier no resolver can map to a scanned
 * module (a package, an unmodelled form) adds no edge here and is enforced
 * when the client environment loads what Vite resolved it to.
 *
 * An ordinary import never propagates: a server-only module may import a
 * shared module that the browser imports as well. The propagation is a
 * breadth-first worklist over reverse re-export edges in which each module
 * is added once, so re-export cycles terminate and `via` follows a shortest
 * chain back to an assertion.
 */
export function scanServerOnlyModules(
  files: readonly string[],
  readFile: ReadFile,
  resolver?: (modules: ReadonlySet<string>) => ModuleResolver,
): ReadonlyMap<string, ServerOnlyModule> {
  const modules = new Set(files);
  const resolveSpecifier = resolver?.(modules) ?? createModuleResolver({ root: "/", modules });
  const forbidden = new Map<string, ServerOnlyModule>();
  /** Re-exported module → the modules that re-export it. */
  const reExporters = new Map<string, string[]>();
  const pending: string[] = [];

  for (const file of files) {
    const facts = serverOnlyFacts(file, readFile(file));

    if (facts.asserted) {
      forbidden.set(file, { file, reason: "server-only-assertion" });
      pending.push(file);
    }

    for (const specifier of facts.reExports) {
      const target = resolveSpecifier(specifier, file);

      if (target) reExporters.set(target, [...(reExporters.get(target) ?? []), file]);
    }
  }

  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    for (const barrel of reExporters.get(next) ?? []) {
      if (forbidden.has(barrel)) continue;

      forbidden.set(barrel, { file: barrel, reason: "server-only-re-export", via: next });
      pending.push(barrel);
    }
  }

  return forbidden;
}

/** `module`, then each module it re-exports, down to the one that asserts server-only. */
export function reExportChain(
  module: ServerOnlyModule,
  forbidden: ReadonlyMap<string, ServerOnlyModule>,
): string[] {
  const chain = [module.file];

  for (let via = module.via; via !== undefined; via = forbidden.get(via)?.via) {
    chain.push(via);
  }

  return chain;
}
