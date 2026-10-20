import { defineEventHandler } from "h3";

import { packedDiStats } from "../../strata/providers";

export default defineEventHandler(() => ({ ...packedDiStats }));
