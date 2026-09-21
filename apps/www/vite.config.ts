import analog from "@analogjs/platform";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Pages deploys one directory. Analog normally keeps the server and public
// output separate, so Cloudflare builds intentionally emit both into its
// upload directory: the generated `_worker.js` can serve the static assets.
const cloudflareOutput =
  process.env["BUILD_PRESET"] === "cloudflare-pages"
    ? { nitro: { output: { dir: "dist/analog/public", publicDir: "dist/analog/public" } } }
    : {};

export default defineConfig(() => ({
  build: {
    target: ["es2022"],
  },
  resolve: {
    mainFields: ["module"],
  },
  plugins: [tailwindcss(), analog({ ssr: true, ...cloudflareOutput })],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.spec.ts"],
  },
}));
