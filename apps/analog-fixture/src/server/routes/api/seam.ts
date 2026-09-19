import { defineEventHandler } from "h3";

import { readSeamSnapshot } from "../../strata/seam-probe";

export default defineEventHandler(() => ({
  source: "nitro-seam",
  snapshot: readSeamSnapshot() ?? null,
}));
