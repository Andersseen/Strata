import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { Plugin } from "vite";

/**
 * Rolldown/oxc (Vite's default TS transform) parses TC39 standard decorators
 * but does not lower them — it emits `@decorator` syntax unchanged, which no
 * current JS engine (including Node 22) can execute. `tsc` already knows how
 * to down-level standard decorators to plain ES output, so this plugin runs
 * `.ts` sources through TypeScript's `transpileModule` first and lets
 * Vite/rolldown handle bundling and further processing as usual.
 */
export function standardDecorators(): Plugin {
  return {
    name: "strata:standard-decorators",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".ts") || id.endsWith(".d.ts") || id.includes("/node_modules/")) {
        return null;
      }

      const result = transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ScriptTarget.ES2023,
          module: ModuleKind.ESNext,
          verbatimModuleSyntax: true,
          sourceMap: true,
        },
      });

      return {
        code: result.outputText,
        map: result.sourceMapText ?? null,
      };
    },
  };
}
