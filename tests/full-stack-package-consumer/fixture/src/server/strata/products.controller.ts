import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

import { CATALOG_FINGERPRINT, findPublicProduct } from "./product-catalog";

let nextInstance = 1;

@Controller("/api/products")
export class ProductsController {
  /** A fresh controller per request: this is `1` on every call and differs per instance. */
  private readonly instance = nextInstance++;
  private calls = 0;

  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    this.calls++;

    const product = findPublicProduct(request.params["id"] ?? "");

    if (!product) {
      // The handler result goes directly to Nitro/H3, which honours a web Response.
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    return new Response(JSON.stringify(product), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-fullstack-catalog": CATALOG_FINGERPRINT,
      },
    });
  }

  @Get("/:id/lifecycle")
  lifecycle() {
    this.calls++;

    return { instance: this.instance, calls: this.calls };
  }
}
