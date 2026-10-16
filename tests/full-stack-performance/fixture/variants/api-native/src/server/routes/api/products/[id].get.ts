import { defineEventHandler, getRouterParam } from "h3";

import { findPublicProduct } from "../../../catalog";

// Native Nitro route: no Strata. It builds its web `Response` exactly as the controller does, so
// the arms differ only in what Strata adds around the handler, not in how the body is produced.
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
  const product = findPublicProduct(getRouterParam(event, "id") ?? "");

  return product ? answer(200, product) : answer(404, { error: "not_found" });
});
