import analog from "@analogjs/platform";
import { defineConfig } from "vite";

// Identical to the Server Component arms' config except for the Strata plugin.
export default defineConfig(() => ({
  build: {
    target: ["es2020"],
    sourcemap: "hidden" as const,
  },
  resolve: {
    mainFields: ["module"],
  },
  ssr: {
    noExternal: ["tslib"],
  },
  plugins: [analog()],
}));
