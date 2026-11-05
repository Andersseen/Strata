import { defineEventHandler } from "h3";

import { completed, compositionStats } from "../../strata/composition.providers";

// Diagnostic only: the harness compares lifecycle counters before and after each scenario and
// reads the completed lifecycle trace of each labelled request.
export default defineEventHandler(() => ({
  ...compositionStats,
  completed: Object.fromEntries(completed),
}));
