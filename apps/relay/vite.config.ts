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
  // Angular's server mode in the SSR graph, so `@defer (hydrate …)` renders
  // its main content on the server. @analogjs/vite-plugin-angular 2.7.2
  // defines `ngServerMode` as false for the whole multi-environment build and
  // only rewrites files named `core.mjs`, missing Angular 22's defer runtime
  // chunk. See docs/research/server-component-defer-poc.md.
  environments: { ssr: { define: { ngServerMode: "true" } } },
  plugins: [
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components",
      // `STRATA_SERVER_COMPONENTS=off`: the plain-SSR control build that proves
      // `pnpm test:relay:server-components` can see a leak.
      enabled: process.env["STRATA_SERVER_COMPONENTS"] !== "off",
    }),
    strataControllerDecorators(),
    tailwindcss(),
    analog({ ssr: true }),
  ],
  test: {
    include: ["src/**/*.spec.ts"],
  },
});
