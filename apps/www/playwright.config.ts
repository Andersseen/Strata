import { defineConfig, devices } from "@playwright/test";

// `pnpm test:www:server-components` runs this suite against servers it already
// built and started (Nitro node-server, then Wrangler's workerd) by setting
// STRATA_WWW_BASE_URL; otherwise Playwright builds and serves the site itself.
const externalBaseUrl = process.env["STRATA_WWW_BASE_URL"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: "pnpm build && node dist/analog/server/index.mjs",
          port: 3000,
          reuseExistingServer: !process.env["CI"],
        },
      }),
});
