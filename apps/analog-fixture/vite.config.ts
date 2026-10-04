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
  // Angular's server mode in the SSR graph. @analogjs/vite-plugin-angular 2.7.2
  // defines `ngServerMode` from `build.ssr`, which is false for the single
  // multi-environment build, and its SSR rewrite only patches files named
  // `core.mjs`; Angular 22 keeps the defer runtime in `_debug_node-chunk.mjs`.
  // Without this, SSR treats hydrate triggers as browser triggers: it renders
  // every `@defer (hydrate …)` placeholder and runs `on viewport` on the
  // server. See docs/research/server-component-defer-poc.md.
  environments: { ssr: { define: { ngServerMode: "true" } } },
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
