import analog from "@analogjs/platform";
import { defineConfig } from "vite";

import { strataServerComponents } from "../../tools/server-components/vite-plugin.ts";

// The stock configuration from the official `create-analog` template (2.7.2):
// no Strata plugin, no decorator transform. One addition, for the SPEC-003
// Angular DI experiment: `@angular/compiler` is a side-effect import in a Nitro
// plugin, and Nitro tree-shakes bare imports unless they are declared here.
// Analog adds the same entry itself, but only when an app has server functions.
//
// The server-component graph PoC adds one private plugin (not a package, not
// public API); `STRATA_SERVER_COMPONENTS=off` builds the plain-SSR control.
// Its fixture-local `@ServerComponent()` decorator makes TypeScript emit
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
      runtimeDir: "src/server-components",
      generatedDir: "src/generated/server-components",
      enabled: process.env["STRATA_SERVER_COMPONENTS"] !== "off",
    }),
    analog({
      nitro: { moduleSideEffects: ["@angular/compiler"] },
    }),
  ],
}));
