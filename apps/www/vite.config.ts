import analog from "@analogjs/platform";
import { strataServerComponents } from "@strata-sc/server-components/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Pages deploys one directory. Analog normally keeps the server and public
// output separate, so Cloudflare builds intentionally emit both into its
// upload directory: the generated `_worker.js` can serve the static assets.
const cloudflareOutput =
  process.env["BUILD_PRESET"] === "cloudflare-pages"
    ? { nitro: { output: { dir: "dist/analog/public", publicDir: "dist/analog/public" } } }
    : {};

// The landing dogfoods the private, experimental @strata-sc/server-components
// package the same way apps/analog-fixture qualifies it: the plugin runs
// before Analog and swaps each `@ServerComponent()` module for a generated
// surrogate (gitignored, under src/generated/) in the browser graph only.
//
// `ssr.noExternal: ["tslib"]`: the `@ServerComponent()` decorator makes
// TypeScript emit tslib's `__decorate` (`importHelpers`). Nitro's trace of an
// external `tslib` ships only `tslib.es6.mjs` while Node resolves
// `modules/index.js`, so SSR fails at runtime unless tslib is bundled.
// See docs/research/server-component-graph-poc.md.
//
// The plugin is off (its plain-SSR control mode) under Vitest, where jsdom unit
// tests render the real Server Component in JIT, and for
// `STRATA_SERVER_COMPONENTS=off`, the control build that proves
// `pnpm test:www:server-components` can see a leak. That gate qualifies the
// browser/server graph split on production builds.
export default defineConfig(() => ({
  build: {
    target: ["es2022"],
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
      enabled:
        process.env["VITEST"] === undefined && process.env["STRATA_SERVER_COMPONENTS"] !== "off",
    }),
    tailwindcss(),
    analog({ ssr: true, ...cloudflareOutput }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.spec.ts"],
  },
}));
