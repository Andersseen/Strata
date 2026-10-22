import analog from "@analogjs/platform";
import { join } from "node:path";

import { strataServerComponents } from "@strata-sc/server-components/vite";
import { defineConfig } from "vite";

// The documented consumer setup for the packed @strata-sc/server-components
// (README "Consumer setup"): the stock create-analog template plus
//   - the Strata plugin, ahead of Analog;
//   - ssr.noExternal: ["tslib"], because `@ServerComponent()` makes TypeScript
//     emit tslib's `__decorate` (importHelpers) and Nitro would otherwise trace
//     only tslib.es6.mjs while Node resolves modules/index.js.
// No @defer is used here, so the `ngServerMode` workaround is not needed.
export default defineConfig(() => ({
  build: {
    target: ["es2020"],
    // Qualification only: lets the runner read each output file's `sources`
    // (hidden maps are written but never referenced from the bundles).
    sourcemap: "hidden" as const,
  },
  resolve: {
    mainFields: ["module"],
    // A consumer-owned Vite alias, mirrored by the `~app/*` tsconfig path that
    // Angular's compiler needs. The plugin reads both when it follows
    // re-exports; `@app/*` is a tsconfig path only.
    alias: { "~app": join(import.meta.dirname, "src", "app") },
  },
  ssr: {
    noExternal: ["tslib"],
  },
  plugins: [
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components",
      clientComponents: [
        {
          selector: "acme-product-picker",
          module: "@strata-test/angular-widgets",
          exportName: "ProductPickerComponent",
        },
      ],
    }),
    analog(),
  ],
}));
