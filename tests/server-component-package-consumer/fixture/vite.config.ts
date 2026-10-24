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
  // Deployment-skew qualification only: a STABLE browser entry URL, the way a CDN-fronted application
  // that serves its entry script from a fixed name does. With hashed entry names a document and a
  // script of different builds cannot meet; with a stable name the script a document loads is
  // whatever the CDN holds under that name.
  ...(process.env["STRATA_STABLE_ENTRY"]
    ? {
        environments: {
          client: { build: { rollupOptions: { output: { entryFileNames: "assets/entry.js" } } } },
        },
      }
    : {}),
  plugins: [
    strataServerComponents({
      root: import.meta.dirname,
      sourceDir: "src/app",
      generatedDir: "src/generated/server-components",
      // Optional deployment identity (README "Deployment compatibility"). Unset, the
      // fixture behaves exactly as it did before the option existed; the two-build
      // qualification (`pnpm test:server-component-deployment-skew`) sets it per release.
      buildId: process.env["STRATA_BUILD_ID"],
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
