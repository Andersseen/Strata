import { defineEventHandler } from "h3";

import { ledgerStats } from "../../../scale/domain";

// Identical native route in all four arms: the benchmark reads the ledger counters after a burst.
export default defineEventHandler(() => ledgerStats());
