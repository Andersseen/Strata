import { defineEventHandler } from "h3";

// A native Nitro route inside the owned `/api` namespace. Strata declares it to the
// boundary (see ../../plugins/strata.ts) but never serves it.
export default defineEventHandler(() => ({ status: "ok", source: "nitro" }));
