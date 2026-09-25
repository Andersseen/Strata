import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// Characterization arm (SPEC-001 §Fixed experiment, step 6): stock Vite runs
// directly on the original consumer TypeScript, with no decorator plugin and
// no tsc pre-compilation. This is a measurement, not the reference recipe.
export default defineConfig({
  build: {
    target: "es2023",
    outDir: "vite-direct-dist",
    emptyOutDir: true,
    ssr: fileURLToPath(new URL("src/consumer.controller.ts", import.meta.url)),
    rollupOptions: {
      external: ["h3", "@strata-sc/core", "@strata-sc/h3"],
      output: {
        format: "es",
        entryFileNames: "main.js",
      },
    },
  },
});
