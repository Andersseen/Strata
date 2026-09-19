import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Analog fixture is an integration fixture built by `pnpm test:analog`,
    // not a unit-test project (it has no specs and no tsconfig.spec.json).
    projects: ["packages/*", "apps/*", "!apps/analog-fixture"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
