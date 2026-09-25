import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// Stage 2 of the reference recipe (SPEC-001 §Fixed experiment, step 5): bundles
// the plain JavaScript tsc already emitted from consumer.controller.ts. Standard
// decorator syntax must not reach this stage — tsc already lowered it.
export default defineConfig({
  build: {
    target: "es2023",
    outDir: "vite-reference-dist",
    emptyOutDir: true,
    ssr: fileURLToPath(new URL("dist/consumer.controller.js", import.meta.url)),
    rollupOptions: {
      external: ["h3", "@strata-sc/core", "@strata-sc/h3"],
      output: {
        format: "es",
        entryFileNames: "main.js",
      },
    },
  },
});
