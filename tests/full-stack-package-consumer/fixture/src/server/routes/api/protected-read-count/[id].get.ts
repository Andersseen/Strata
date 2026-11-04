import { defineEventHandler, getRouterParam, setHeader } from "h3";

import { takeProtectedReads } from "../../../strata/tenant-authorization";

/** Fixture-only endpoint consumes one request's read observation without returning identity data. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id") ?? "";
  setHeader(event, "cache-control", "no-store");

  return { reads: takeProtectedReads(id) };
});
