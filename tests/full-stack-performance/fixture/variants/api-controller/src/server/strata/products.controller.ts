import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

import { findPublicProduct } from "../catalog";

const HANDLER_MARKER = "PERF_CONTROLLER_MARKER";

const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-perf-handler": HANDLER_MARKER,
    },
  });

@Controller("/api/products")
export class ProductsController {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    const product = findPublicProduct(request.params["id"] ?? "");

    return product ? answer(200, product) : answer(404, { error: "not_found" });
  }
}
