import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

import { standardDecorators } from "./vite-plugin-standard-decorators.js";

// Changesets bumps package.json on release; the build inlines that version so
// STRATA_VERSION can never drift from the published package again.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __STRATA_VERSION__: JSON.stringify(version),
  },
  plugins: [
    standardDecorators(),
    dts({
      tsconfigPath: "./tsconfig.build.json",
      include: ["src"],
    }),
  ],
  build: {
    target: "es2023",
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL("src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: "index",
    },
  },
  test: {
    name: "@strata-sc/core",
    environment: "node",
  },
});
