import analog from "@analogjs/platform";
import { defineConfig } from "vite";

// The stock configuration from the official `create-analog` template (2.7.2):
// no Strata plugin, no decorator transform. One addition, for the SPEC-003
// Angular DI experiment: `@angular/compiler` is a side-effect import in a Nitro
// plugin, and Nitro tree-shakes bare imports unless they are declared here.
// Analog adds the same entry itself, but only when an app has server functions.
export default defineConfig(() => ({
  build: {
    target: ["es2020"],
  },
  resolve: {
    mainFields: ["module"],
  },
  plugins: [
    analog({
      nitro: { moduleSideEffects: ["@angular/compiler"] },
    }),
  ],
}));
