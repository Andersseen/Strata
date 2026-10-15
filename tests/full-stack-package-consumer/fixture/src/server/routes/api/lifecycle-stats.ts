import { defineEventHandler } from "h3";

import { lifecycleStats } from "../../strata/lifecycle-stats";

export default defineEventHandler(() => ({ ...lifecycleStats }));
