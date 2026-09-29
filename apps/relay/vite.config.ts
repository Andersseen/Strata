import analog from "@analogjs/platform";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import tailwindcss from "@tailwindcss/vite";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

function strataControllerDecorators(): Plugin {
  return {
    name: "relay:strata-standard-decorators",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/src/server/strata/") || !id.endsWith(".controller.ts")) {
        return null;
      }

      const result = transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ScriptTarget.ES2022,
          module: ModuleKind.ESNext,
          verbatimModuleSyntax: true,
          sourceMap: true,
        },
      });

      return { code: result.outputText, map: result.sourceMapText ?? null };
    },
  };
}

export default defineConfig({
  build: {
    target: ["es2022"],
  },
  resolve: {
    mainFields: ["module"],
  },
  ssr: {
    noExternal: ["tslib"],
  },
  plugins: [
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components",
      enabled: true,
    }),
    strataControllerDecorators(),
    tailwindcss(),
    analog({ ssr: true }),
  ],
  test: {
    include: ["src/**/*.spec.ts"],
  },
});
