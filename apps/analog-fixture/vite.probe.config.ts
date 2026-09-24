import analog from "@analogjs/platform";
import { defineConfig } from "vite";

// Characterization-only configuration. Identical to vite.config.ts except that
// it also builds the Angular-graph decorator probe page. The tsconfig is
// selected by the runner so the same probe can be observed with the stock
// `experimentalDecorators: true` and with it turned off.
const tsconfig = process.env["STRATA_ANALOG_PROBE_TSCONFIG"] ?? "tsconfig.probe.app.json";

export default defineConfig(() => ({
  build: {
    target: ["es2020"],
  },
  resolve: {
    mainFields: ["module"],
  },
  plugins: [
    analog({
      additionalPagesDirs: ["/src/probes/angular-graph/pages"],
      vite: { tsconfig },
      nitro: { moduleSideEffects: ["@angular/compiler"] },
    }),
  ],
}));
