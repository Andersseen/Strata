import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type * as TypeScript from "typescript";

import { run } from "../../consumer/lib/exec.ts";

import { check, repoRoot } from "./harness.ts";

/**
 * The public API surface of the INSTALLED Strata packages, as a consumer sees it
 * (docs/research/m3-m4-contract-stabilization.md, "Public API inventory").
 *
 * For every subpath in each installed `package.json` `exports` map:
 *   - the `types` and runtime targets exist in the installed package;
 *   - the consumer's own TypeScript enumerates the declared exports and their kind;
 *   - the consumer's Node imports the entry and lists its runtime exports;
 *   - every declared VALUE export exists at runtime and nothing exists at runtime undeclared;
 *   - the whole surface equals the reviewed baseline `tools/package-consumer/public-api.json`.
 *
 * It is a structural contract, not an implementation snapshot: names, kinds and subpaths only.
 * An intended change is reviewed by regenerating the baseline
 * (`STRATA_UPDATE_PUBLIC_API=1`) and recording the SemVer decision in a Changeset.
 */

export const PUBLIC_PACKAGES = [
  "@strata-sc/core",
  "@strata-sc/analog",
  "@strata-sc/server-components",
] as const;
export const PUBLIC_API_BASELINE = join(repoRoot, "tools", "package-consumer", "public-api.json");

/** name → kind ("class" | "function" | "const" | "interface" | "type" | "enum" | "namespace"). */
type Exports = Record<string, string>;
/** package → subpath → exports. */
export type PublicSurface = Record<string, Record<string, Exports>>;

interface ExportTarget {
  readonly subpath: string;
  readonly types: string | undefined;
  readonly runtime: string | undefined;
}

type Conditions =
  string | { readonly types?: string; readonly import?: string; readonly default?: string };

function exportTargets(manifest: { exports?: Record<string, Conditions> }): ExportTarget[] {
  return Object.entries(manifest.exports ?? {})
    .filter(([subpath]) => subpath !== "./package.json")
    .map(([subpath, conditions]) =>
      typeof conditions === "string"
        ? { subpath, types: undefined, runtime: conditions }
        : { subpath, types: conditions.types, runtime: conditions.import ?? conditions.default },
    );
}

/** Kinds as the consumer's TypeScript resolves them. */
function declaredExports(consumerDir: string, files: readonly string[]): Map<string, Exports> {
  const require = createRequire(join(consumerDir, "package.json"));
  const ts = require("typescript") as typeof TypeScript;
  const program = ts.createProgram(files, {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
  });
  const checker = program.getTypeChecker();
  const kindOf = (symbol: TypeScript.Symbol): string => {
    const flags = symbol.flags;
    if (flags & ts.SymbolFlags.Class) return "class";
    if (flags & ts.SymbolFlags.Function) return "function";
    if (flags & ts.SymbolFlags.Enum) return "enum";
    if (flags & ts.SymbolFlags.Variable) return "const";
    if (flags & ts.SymbolFlags.Interface) return "interface";
    if (flags & ts.SymbolFlags.TypeAlias) return "type";
    if (flags & ts.SymbolFlags.Module) return "namespace";
    return "unknown";
  };
  const typeOnly = (symbol: TypeScript.Symbol): boolean =>
    (symbol.declarations ?? []).some(
      (declaration) =>
        ts.isTypeOnlyImportOrExportDeclaration(declaration) ||
        (ts.isExportSpecifier(declaration) && declaration.parent.parent.isTypeOnly),
    );
  const result = new Map<string, Exports>();

  for (const file of files) {
    const source = program.getSourceFile(file);
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    const exports: Exports = {};

    for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const kind = kindOf(target);
      // A class or enum re-exported with `export type` has no runtime binding.
      exports[symbol.name] =
        typeOnly(symbol) && (kind === "class" || kind === "enum") ? `type-only ${kind}` : kind;
    }
    result.set(file, sortKeys(exports));
  }

  return result;
}

const VALUE_KINDS = new Set(["class", "function", "const", "enum"]);

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** Imports every subpath in the consumer's own Node, in one process. */
function runtimeExports(
  consumerDir: string,
  env: NodeJS.ProcessEnv,
  specifiers: readonly string[],
): Record<string, string[] | { error: string }> {
  // Angular's partial-compiled packages need the JIT compiler loaded before they are evaluated
  // outside a build (the same reason Nitro's server graph imports it).
  const script = `
    await import("@angular/compiler");
    const result = {};
    for (const specifier of ${JSON.stringify(specifiers)}) {
      try { result[specifier] = Object.keys(await import(specifier)).sort(); }
      catch (error) { result[specifier] = { error: String(error?.message ?? error).slice(0, 300) }; }
    }
    console.log("STRATA_PUBLIC_API" + JSON.stringify(result));
  `;
  const output = run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: consumerDir,
    env,
  });
  const line = output.stdout.split("\n").find((entry) => entry.startsWith("STRATA_PUBLIC_API"));

  if (!line) throw new Error(`runtime export listing failed: ${output.stderr.slice(-1_000)}`);

  return JSON.parse(line.slice("STRATA_PUBLIC_API".length)) as Record<
    string,
    string[] | { error: string }
  >;
}

/** Reads the installed surface and checks it; returns whether every check passed. */
export function checkPublicApi(
  consumerDir: string,
  env: NodeJS.ProcessEnv,
  label: string,
): boolean {
  const results: boolean[] = [];
  const surface: PublicSurface = {};
  const typeFiles: string[] = [];
  const entries: { name: string; target: ExportTarget; root: string; specifier: string }[] = [];

  for (const name of PUBLIC_PACKAGES) {
    const root = join(consumerDir, "node_modules", name);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports?: Record<string, Conditions>;
    };
    const targets = exportTargets(manifest);
    const missing = targets.flatMap((target) =>
      (
        [
          ["types", target.types],
          ["runtime", target.runtime],
        ] as const
      )
        .filter(([, file]) => file === undefined || !existsSync(join(root, file)))
        .map(([condition, file]) => `${target.subpath} ${condition} → ${file ?? "not declared"}`),
    );
    results.push(
      check(
        `${label}: ${name} — every exports subpath has an installed types and runtime target`,
        targets.length > 0 && missing.length === 0,
        missing.join(", "),
      ),
    );
    for (const target of targets) {
      const specifier = target.subpath === "." ? name : `${name}/${target.subpath.slice(2)}`;
      if (target.types) typeFiles.push(join(root, target.types));
      entries.push({ name, target, root, specifier });
    }
  }

  const declared = declaredExports(consumerDir, typeFiles);
  const runtime = runtimeExports(
    consumerDir,
    env,
    entries.map((entry) => entry.specifier),
  );

  for (const { name, target, root, specifier } of entries) {
    const exports = target.types ? (declared.get(join(root, target.types)) ?? {}) : {};
    const values = Object.entries(exports)
      .filter(([, kind]) => VALUE_KINDS.has(kind))
      .map(([exported]) => exported)
      .sort();
    const listed = runtime[specifier];
    const actual = Array.isArray(listed) ? listed : [];

    (surface[name] ??= {})[target.subpath] = exports;
    results.push(
      check(
        `${label}: ${specifier} — declared value exports equal the runtime exports (${values.length})`,
        Array.isArray(listed) &&
          JSON.stringify(values) === JSON.stringify(actual) &&
          !Object.values(exports).includes("unknown"),
        Array.isArray(listed)
          ? `declared-only: ${values.filter((value) => !actual.includes(value)).join(", ")}; ` +
              `runtime-only: ${actual.filter((value) => !values.includes(value)).join(", ")}`
          : listed?.error,
      ),
    );
  }

  const serialized = `${JSON.stringify(surface, null, 2)}\n`;

  if (process.env["STRATA_UPDATE_PUBLIC_API"] === "1") {
    writeFileSync(PUBLIC_API_BASELINE, serialized);
    console.log(`public API baseline written: ${PUBLIC_API_BASELINE}`);
  }

  const baseline = existsSync(PUBLIC_API_BASELINE)
    ? (JSON.parse(readFileSync(PUBLIC_API_BASELINE, "utf8")) as PublicSurface)
    : undefined;
  results.push(
    check(
      `${label}: the installed public surface equals the reviewed baseline (${dirname(PUBLIC_API_BASELINE).slice(repoRoot.length + 1)}/public-api.json)`,
      baseline !== undefined && JSON.stringify(baseline) === JSON.stringify(surface),
      baseline
        ? describeDifference(baseline, surface)
        : "no baseline: run with STRATA_UPDATE_PUBLIC_API=1",
    ),
  );

  return results.every(Boolean);
}

/** Added, removed and re-kinded exports, one per line, for a reviewer. */
export function describeDifference(baseline: PublicSurface, actual: PublicSurface): string {
  const lines: string[] = [];
  const packages = new Set([...Object.keys(baseline), ...Object.keys(actual)]);

  for (const name of packages) {
    const subpaths = new Set([
      ...Object.keys(baseline[name] ?? {}),
      ...Object.keys(actual[name] ?? {}),
    ]);
    for (const subpath of subpaths) {
      const before = baseline[name]?.[subpath];
      const after = actual[name]?.[subpath];
      if (!before) lines.push(`+ ${name} ${subpath} (new subpath)`);
      else if (!after) lines.push(`- ${name} ${subpath} (removed subpath)`);
      else {
        for (const exported of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (before[exported] === after[exported]) continue;
          lines.push(
            `${name}${subpath === "." ? "" : subpath.slice(1)} ${exported}: ${before[exported] ?? "absent"} → ${after[exported] ?? "removed"}`,
          );
        }
      }
    }
  }

  return lines.join("; ").slice(0, 1_500);
}
