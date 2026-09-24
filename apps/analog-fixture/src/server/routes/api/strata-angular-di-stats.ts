import { defineEventHandler } from "h3";

import { angularDiStats } from "../../strata/angular-di/angular-controller-factory";

// Diagnostic only: lets the harness check that every request injector the
// experiment created was destroyed.
export default defineEventHandler(() => ({ ...angularDiStats }));
