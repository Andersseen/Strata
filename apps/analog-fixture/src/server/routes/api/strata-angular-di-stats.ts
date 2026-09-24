import { defineEventHandler } from "h3";

import { angularDiStats } from "../../strata/angular-di/providers";

// Diagnostic only: lets the harness compare lifecycle counters before and after
// each Angular DI scenario.
export default defineEventHandler(() => ({ ...angularDiStats }));
