/* eslint-disable import-x/no-named-as-default-member -- TypeScript ships
   CommonJS, so only its default export is reliable from ESM. */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import ts from "typescript";

import { stripQuery } from "./module-id.js";

/**
 * Maps a specifier written in `importer` to the scanned app module it names,
 * or `undefined` when it names anything else (a package, an unscanned file, a
 * form this resolver does not model). `undefined` is never a verdict that the
 * target is safe: the client load/transform firewall enforces the resolved
 * identity of whatever Vite does load.
 */
export type ModuleResolver = (specifier: string, importer: string) => string | undefined;

/** A Vite `resolve.alias` entry, as the resolved config normalizes it. */
export interface ViteAlias {
  readonly find: string | RegExp;
  readonly replacement: string;
}

export interface ModuleResolverInput {
  readonly root: string;
  /** The scanned modules (absolute paths): the only possible results. */
  readonly modules: ReadonlySet<string>;
  readonly aliases?: readonly ViteAlias[];
  /** Absolute path of the tsconfig whose `paths` / `baseUrl` apply, if any. */
  readonly tsconfig?: string | undefined;
}

/** The suffixes a written module path may resolve through, in Vite's order of preference. */
function candidates(base: string): string[] {
  return [
    base,
    `${base}.ts`,
    join(base, "index.ts"),
    // `./x.js` written in a TypeScript source names `./x.ts`.
    base.replace(/\.m?js$/, ".ts"),
  ];
}

function pick(base: string, modules: ReadonlySet<string>): string | undefined {
  return candidates(base).find((candidate) => modules.has(candidate));
}

/**
 * Applies the first matching Vite alias, with Vite's own semantics
 * (`@rollup/plugin-alias`): a string `find` matches the exact specifier or
 * the specifier followed by `/`; a RegExp matches anywhere and is replaced
 * with `String.prototype.replace`.
 */
export function applyAlias(specifier: string, aliases: readonly ViteAlias[]): string | undefined {
  for (const { find, replacement } of aliases) {
    if (typeof find === "string") {
      if (specifier === find || specifier.startsWith(`${find}/`)) {
        return replacement + specifier.slice(find.length);
      }
    } else if (find.test(specifier)) {
      // A global or sticky RegExp keeps `lastIndex` between calls.
      find.lastIndex = 0;

      return specifier.replace(find, replacement);
    }
  }

  return undefined;
}

/** What a tsconfig declares for module resolution, read once per resolver. */
interface TsResolution {
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
  readonly hasMapping: boolean;
}

function readTsResolution(root: string, tsconfig: string | undefined): TsResolution | undefined {
  if (!tsconfig || !existsSync(tsconfig)) return undefined;

  const read = ts.readConfigFile(tsconfig, (path) => ts.sys.readFile(path));

  if (read.error) return undefined;

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig));
  const options: ts.CompilerOptions = {
    ...parsed.options,
    // Package resolution stays Vite's job; TypeScript is asked about the
    // app's own mappings only, with the resolution mode a bundler uses.
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
  };

  return {
    options,
    cache: ts.createModuleResolutionCache(root, (name) => name, options),
    hasMapping: options.paths !== undefined || options.baseUrl !== undefined,
  };
}

/**
 * The resolver for one graph generation. Specifiers resolve, in this order,
 * through:
 *
 *   1. relative paths (`./x`, `../x`, `./dir` → `./dir/index.ts`, `./x.js` → `./x.ts`);
 *   2. Vite `resolve.alias`;
 *   3. the tsconfig's `paths` and `baseUrl`, resolved by TypeScript itself.
 *
 * Only a result inside `modules` is returned, so the resolver can never be
 * asked to crawl `node_modules`: a package specifier resolves to `undefined`
 * and is enforced when Vite loads what it resolved. The TypeScript module
 * resolution cache lives and dies with the resolver.
 */
export function createModuleResolver(input: ModuleResolverInput): ModuleResolver {
  const { root, modules, aliases = [] } = input;
  const typescript = readTsResolution(root, input.tsconfig);

  return (specifier, importer) => {
    const path = stripQuery(specifier);

    if (path.startsWith(".")) return pick(resolve(dirname(importer), path), modules);

    const aliased = applyAlias(path, aliases);

    if (aliased !== undefined) {
      const target = isAbsolute(aliased)
        ? aliased
        : aliased.startsWith(".")
          ? resolve(root, aliased)
          : undefined;

      if (target) return pick(target, modules);
    }

    if (typescript?.hasMapping) {
      const { resolvedModule } = ts.resolveModuleName(
        path,
        importer,
        typescript.options,
        ts.sys,
        typescript.cache,
      );

      if (resolvedModule && modules.has(resolvedModule.resolvedFileName)) {
        return resolvedModule.resolvedFileName;
      }
    }

    return undefined;
  };
}

/** The tsconfig that governs the app program: `tsconfig.app.json`, else `tsconfig.json`. */
export function findTsconfig(root: string): string | undefined {
  return ["tsconfig.app.json", "tsconfig.json"].map((name) => join(root, name)).find(existsSync);
}
