import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

import { CATALOG_FINGERPRINT } from "./product-catalog";

// Qualification-only request correlation. Every answer names the synthetic
// resource and the synthetic correlation id the REQUEST carried, so a runner can
// prove that a response belongs to the request that was sent. The id is an
// untrusted label echoed back (never credentials, never authorization); it is
// bounded and restricted to a safe alphabet so the echo cannot carry markup.
const RESOURCES: ReadonlySet<string> = new Set(["alpha", "beta", "gamma"]);
const CORRELATION = /^[a-z0-9-]{1,48}$/;

const answer = (status: number, body: unknown, withFingerprint = false): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(withFingerprint ? { "x-fullstack-catalog": CATALOG_FINGERPRINT } : {}),
    },
  });

@Controller("/api/qualification")
export class QualificationController {
  @Get("/:resource")
  find(request: StrataAnalogRequest) {
    const resource = request.params["resource"] ?? "";
    const correlation = request.query["cid"];

    if (!RESOURCES.has(resource)) return answer(404, { error: "not_found" });

    if (typeof correlation !== "string" || !CORRELATION.test(correlation))
      return answer(400, { error: "invalid_correlation" });

    return answer(200, { resource, correlation, path: request.path }, true);
  }
}
