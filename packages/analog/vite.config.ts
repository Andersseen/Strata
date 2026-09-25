import { fileURLToPath } from "node:url";

import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

import { standardDecorators } from "./vite-plugin-standard-decorators.js";

export default defineConfig({
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
    rollupOptions: {
      external: ["@strata-sc/core"],
    },
  },
  test: {
    name: "@strata-sc/analog",
    environment: "node",
  },
});
