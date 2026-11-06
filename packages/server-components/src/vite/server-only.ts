/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { readFileSync, statSync } from "node:fs";

import ts from "typescript";

import { RUNTIME_PACKAGE } from "./analyze.js";
import type { ReadFile } from "./analyze.js";
import { createModuleResolver } from "./resolve.js";
import type { ModuleResolver } from "./resolve.js";

/** The side-effect import that marks a module as never allowed in a browser graph. */
export const SERVER_ONLY_SPECIFIER = `${RUNTIME_PACKAGE}/server-only`;

/** A file the walk of {@link findServerOnlyChain} and the emitted-output check may read as a module. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/**
 * A cheap test that a module may hold a re-export, so a large bundled entry
 * without one skips the parse. A form it misses adds no edge to the walk and is
 * still refused when Vite loads the module.
 */
const RE_EXPORT_HINT = /\bexport\s*(?:\*[^;'"]*|\{[^}]*\})\s*from\b/;
/** Modules one walk visits before it stops. Far above a real package's re-export closure. */
export const MAX_RE_EXPORT_WALK = 4_096;

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
 * string or a template literal is not an import. `export type { … } from` and
 * `export { type A, type B } from` are erased by TypeScript and load nothing,
 * so they are not re-exports here. A compiler told to keep the second form
 * loads the module, and the load itself is then refused.
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
      !isTypeOnlyExport(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      reExports.push(statement.moduleSpecifier.text);
    }
  }

  return { asserted, reExports };
}

function isTypeOnlyExport(statement: ts.ExportDeclaration): boolean {
  const clause = statement.exportClause;

  return (
    statement.isTypeOnly ||
    (clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly))
  );
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
 * module (a package, an unmodelled form) adds no edge here: a package import
 * is walked by {@link findServerOnlyChain} when the client environment resolves
 * it, and anything else is enforced when that environment loads it.
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

/** Where a walk from an entry ended. */
export interface ServerOnlyWalk {
  /** The entry, then each module it re-exports, down to the one that asserts server-only. */
  readonly chain?: readonly string[];
  /** The walk stopped at its limit, so a chain may exist beyond what it visited. */
  readonly truncated: boolean;
}

/**
 * Whether `entry`, a module outside the scanned sources that the browser graph
 * is about to reach, asserts server-only or re-exports a module that does.
 *
 * It follows re-export edges only, downward from one entry, through `resolve`
 * (Vite's own resolution for the importing environment), so it visits what that
 * entry exposes and never the rest of its package or of `node_modules`. An
 * ordinary import is not followed: the bundler reaches it and this runs again
 * there. Breadth-first with each module visited once, so a cycle terminates and
 * the chain is a shortest one, in declaration order.
 *
 * `undefined` facts or an unresolved specifier add nothing. That is no verdict
 * of safety: a truncated or incomplete walk leaves the module to the assertion
 * check that runs when the bundler loads it.
 */
export async function findServerOnlyChain(
  entry: string,
  factsOf: (file: string) => ServerOnlyFacts | undefined,
  resolve: (specifier: string, importer: string) => Promise<string | undefined>,
  limit = MAX_RE_EXPORT_WALK,
): Promise<ServerOnlyWalk> {
  const parents = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];

  for (const file of queue) {
    const facts = factsOf(file);

    if (!facts) continue;

    if (facts.asserted) {
      const chain = [file];

      for (let up = parents.get(file); up !== undefined; up = parents.get(up)) chain.unshift(up);

      return { chain, truncated: false };
    }

    const targets = await Promise.all(facts.reExports.map((source) => resolve(source, file)));

    for (const target of targets) {
      if (target === undefined || parents.has(target)) continue;
      if (parents.size >= limit) return { truncated: true };

      parents.set(target, file);
      queue.push(target);
    }
  }

  return { truncated: false };
}

/**
 * Reads {@link ServerOnlyFacts} from installed files. A parse is kept until the
 * file's size or modification time changes, so the dev server pays for a large
 * package once and still sees an edit in a linked package. `undefined` for
 * anything that is not a readable script.
 */
export function createInstalledFacts(): (file: string) => ServerOnlyFacts | undefined {
  const known = new Map<string, { readonly stamp: string; readonly facts: ServerOnlyFacts }>();

  return (file) => {
    if (!SCRIPT_FILE.test(file) || file.endsWith(".d.ts")) return undefined;

    try {
      const { mtimeMs, size } = statSync(file);
      const stamp = `${mtimeMs}:${size}`;
      const cached = known.get(file);

      if (cached?.stamp === stamp) return cached.facts;

      const text = readFileSync(file, "utf8");
      const facts =
        text.includes(SERVER_ONLY_SPECIFIER) || RE_EXPORT_HINT.test(text)
          ? serverOnlyFacts(file, text)
          : { asserted: false, reExports: [] };

      known.set(file, { stamp, facts });

      return facts;
    } catch {
      return undefined;
    }
  };
}

const assertsServerOnly = (name: string, text: string): boolean =>
  text.includes(SERVER_ONLY_SPECIFIER) && serverOnlyFacts(name, text).asserted;

/** An inlined file as a bundler writes it into a chunk: Vite's `?url` and `new URL()` below the inline limit. */
const BASE64_DATA_URL = /data:[\w.+/-]*(?:;[\w=.-]+)*;base64,([A-Za-z0-9+/=]+)/g;

/** The slice of a bundle entry {@link emittedServerOnly} reads. */
export type EmittedOutput =
  | {
      readonly type: "asset";
      readonly fileName: string;
      readonly source: string | Uint8Array;
      readonly originalFileNames?: readonly string[];
    }
  | { readonly type: "chunk"; readonly fileName: string; readonly code: string };

/**
 * What an output file holds of a server-only module, by the module's own
 * assertion, or `undefined`. `new URL("./x.js", import.meta.url)` is resolved by
 * Vite outside the plugin pipeline and copies the file as an asset or inlines it
 * as a data URL, so neither `resolveId` nor `load` is told. Only a file that is
 * itself a module counts: a chunk that merely displays the assertion as text is
 * a string literal in a larger module, not a copy of one.
 */
export function emittedServerOnly(output: EmittedOutput): string | undefined {
  if (output.type === "asset") {
    const names = [output.fileName, ...(output.originalFileNames ?? [])];

    if (!names.some((name) => SCRIPT_FILE.test(name))) return undefined;

    const text =
      typeof output.source === "string"
        ? output.source
        : Buffer.from(output.source).toString("utf8");

    return assertsServerOnly(output.fileName, text) ? output.fileName : undefined;
  }

  for (const [, encoded] of output.code.matchAll(BASE64_DATA_URL)) {
    const text = Buffer.from(encoded as string, "base64").toString("utf8");

    if (assertsServerOnly("inlined.ts", text)) return output.fileName;
  }

  return undefined;
}
