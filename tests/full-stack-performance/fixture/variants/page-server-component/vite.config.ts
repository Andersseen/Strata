import analog from "@analogjs/platform";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import { defineConfig } from "vite";

// The documented consumer setup (README "Consumer setup"): the Strata plugin
// ahead of Analog. Everything else is identical to the plain-Angular arms' config.
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
  plugins: [
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components",
    }),
    analog(),
  ],
}));
