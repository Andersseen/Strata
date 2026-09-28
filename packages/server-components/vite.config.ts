import { fileURLToPath } from "node:url";

import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

// Builds the Node-only `./vite` entry. The Angular runtime entry (`.`) is
// partial-compiled by `ngc -p tsconfig.runtime.json`, which runs after this
// build (this one empties `dist/`).
export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: "./tsconfig.json",
      include: ["src/vite"],
      exclude: ["src/**/*.test.ts"],
      entryRoot: "src",
    }),
  ],
  build: {
    target: "es2023",
    sourcemap: true,
    lib: {
      entry: { vite: fileURLToPath(new URL("src/vite/index.ts", import.meta.url)) },
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^node:/, "@angular/compiler", "typescript", "vite"],
    },
  },
  test: {
    name: "@strata-sc/server-components",
    environment: "node",
  },
});
