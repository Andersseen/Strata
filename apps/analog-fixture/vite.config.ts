import analog from "@analogjs/platform";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import { defineConfig } from "vite";

// The stock configuration from the official `create-analog` template (2.7.2):
// no Strata plugin, no decorator transform. One addition, for the SPEC-003
// Angular DI experiment: `@angular/compiler` is a side-effect import in a Nitro
// plugin, and Nitro tree-shakes bare imports unless they are declared here.
// Analog adds the same entry itself, but only when an app has server functions.
//
// The server-component graph PoC adds one plugin from the private, experimental
// @strata-sc/server-components package (not published, not public API);
// `STRATA_SERVER_COMPONENTS=off` builds the plain-SSR control.
// Its `@ServerComponent()` decorator makes TypeScript emit
// `tslib`'s `__decorate` (`importHelpers`), and Nitro's trace of `tslib` ships
// only `tslib.es6.mjs` while Node resolves `modules/index.js`, so SSR of that
// page fails at runtime unless `tslib` is bundled into the SSR output.
// See docs/research/server-component-graph-poc.md.
export default defineConfig(() => ({
  build: {
    target: ["es2020"],
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
      enabled: process.env["STRATA_SERVER_COMPONENTS"] !== "off",
    }),
    analog({
      nitro: { moduleSideEffects: ["@angular/compiler"] },
    }),
  ],
}));
