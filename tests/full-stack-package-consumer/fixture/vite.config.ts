import analog from "@analogjs/platform";
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
  },
  ssr: {
    noExternal: ["tslib"],
  },
  // Upgrade/rollback qualification only (`pnpm test:full-stack-registry-upgrade-rollback`): a STABLE
  // browser entry URL, so a document and a script of different builds can meet the way a CDN-fronted
  // deployment lets them. Unset, the fixture's entry names are the stock hashed ones.
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
      // Optional deployment identity (README "Deployment compatibility"). Unset, the fixture
      // behaves exactly as it did before the option existed; the upgrade/rollback qualification
      // sets one distinct application build id per release.
      buildId: process.env["STRATA_BUILD_ID"],
    }),
    analog(),
  ],
}));
