import analog from "@analogjs/platform";
import { defineConfig } from "vite";

// Deliberately the stock configuration from the official `create-analog`
// template (2.7.2): no Strata plugin, no decorator transform, no overrides.
// The fixture exists to observe what the native Analog pipeline does.
export default defineConfig(() => ({
  build: {
    target: ["es2020"],
  },
  resolve: {
    mainFields: ["module"],
  },
  plugins: [analog()],
}));
