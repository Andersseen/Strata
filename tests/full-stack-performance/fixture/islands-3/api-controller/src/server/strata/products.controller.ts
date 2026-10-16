import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

import { findPublicProduct } from "../catalog";
import { findPublicDelivery, findPublicStock } from "../inventory";

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

  @Get("/:id/stock")
  stock(request: StrataAnalogRequest) {
    const stock = findPublicStock(request.params["id"] ?? "");

    return stock ? answer(200, stock) : answer(404, { error: "not_found" });
  }

  @Get("/:id/delivery")
  delivery(request: StrataAnalogRequest) {
    const delivery = findPublicDelivery(request.params["id"] ?? "");

    return delivery ? answer(200, delivery) : answer(404, { error: "not_found" });
  }
}
