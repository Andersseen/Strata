import { defineEventHandler, getRequestHeader, setHeader, setResponseStatus } from "h3";

import {
  READ_OBSERVATION_HEADER,
  readProtectedResource,
} from "../../../strata/tenant-authorization";

/**
 * TEST-ONLY NEGATIVE CONTROL. The defect class the read receipt exists to catch: a handler that
 * reads tenant-private data BEFORE it denies. Its response is a perfect denial (403, no data, no
 * marker), so status and body alone cannot reveal the read; the verifier requires the receipt to
 * show it. Nothing read is returned.
 */
export default defineEventHandler((event) => {
  readProtectedResource("alpha-product", {
    headers: new Headers({
      [READ_OBSERVATION_HEADER]: getRequestHeader(event, READ_OBSERVATION_HEADER) ?? "",
    }),
  });
  setHeader(event, "cache-control", "no-store");
  setHeader(event, "content-type", "application/json");
  setResponseStatus(event, 403);

  return '{"error":"forbidden"}';
});
