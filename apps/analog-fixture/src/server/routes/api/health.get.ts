import { defineEventHandler } from "h3";

// A native Nitro route inside the owned `/api` namespace: declared to the boundary in
// ../../plugins/strata.ts, served by Nitro itself.
export default defineEventHandler(() => ({ status: "ok", source: "nitro" }));
