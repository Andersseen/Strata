import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/release/lib/*.test.ts"],
    root: new URL("../..", import.meta.url).pathname,
  },
});
