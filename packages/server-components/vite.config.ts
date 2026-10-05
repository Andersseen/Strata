import { fileURLToPath } from "node:url";

import dts from "vite-plugin-dts";
import { defineConfig } from "vitest/config";

// Builds the Node-only `./vite` entry and the empty `./server-only` assertion
// entry. The Angular runtime entry (`.`) is partial-compiled by
// `ngc -p tsconfig.runtime.json`, which runs after this build (this one
// empties `dist/`).
export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: "./tsconfig.json",
      include: ["src/vite", "src/server-only"],
      exclude: ["src/**/*.test.ts"],
      entryRoot: "src",
    }),
  ],
  build: {
    target: "es2023",
    sourcemap: true,
    lib: {
      entry: {
        vite: fileURLToPath(new URL("src/vite/index.ts", import.meta.url)),
        "server-only": fileURLToPath(new URL("src/server-only/index.ts", import.meta.url)),
      },
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
