import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/ci/lib/*.test.ts"],
    root: fileURLToPath(new URL("../..", import.meta.url)),
  },
});
