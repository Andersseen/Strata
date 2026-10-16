import { defineEventHandler, getRouterParam } from "h3";

import { findPublicStock } from "../../../../inventory";

// Native Nitro route: no Strata. Builds its web `Response` exactly as the controller does.
const HANDLER_MARKER = "PERF_NATIVE_HANDLER_MARKER";

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-perf-handler": HANDLER_MARKER,
    },
  });

export default defineEventHandler((event) => {
  const result = findPublicStock(getRouterParam(event, "id") ?? "");

  return result ? answer(200, result) : answer(404, { error: "not_found" });
});
