import { defineConfig, devices } from "@playwright/test";

// `pnpm test:relay:server-components` runs this suite against a server it
// already built and started by setting STRATA_RELAY_BASE_URL; otherwise
// Playwright builds and serves Relay itself.
const externalBaseUrl = process.env["STRATA_RELAY_BASE_URL"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: externalBaseUrl ?? "http://127.0.0.1:4310",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: "pnpm build && NITRO_PORT=4310 pnpm preview",
          port: 4310,
          reuseExistingServer: !process.env["CI"],
        },
      }),
});
