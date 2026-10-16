import { defineEventHandler, getRouterParam, setResponseHeaders, setResponseStatus } from "h3";

import { findPublicProduct } from "../../../catalog";

// Idiomatic h3 handler (object return), selectable with STRATA_PERF_NATIVE_HANDLER=object: a
// diagnostic only, because h3 serializes the object through its Node-compat response path.
const HANDLER_MARKER = "PERF_NATIVE_HANDLER_MARKER";

export default defineEventHandler((event) => {
  setResponseHeaders(event, { "cache-control": "no-store", "x-perf-handler": HANDLER_MARKER });

  const product = findPublicProduct(getRouterParam(event, "id") ?? "");

  if (!product) {
    setResponseStatus(event, 404);

    return { error: "not_found" };
  }

  return product;
});
