import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import { StrataAnalogHttpError, jsonResponse, noContent } from "@strata-sc/analog";

@Controller("/api/application-contract")
export class HttpContractController {
  @Get("/missing")
  missing() {
    throw new StrataAnalogHttpError(404, "not_found", "private message canary", {
      cause: new Error("private cause canary"),
    });
  }

  @Post("/created")
  created() {
    const headers = new Headers({ "cache-control": "private, max-age=15" });
    headers.append("set-cookie", "first=1; Path=/; HttpOnly");
    headers.append("set-cookie", "second=2; Path=/; Secure");
    return jsonResponse({ id: "packed-product" }, { status: 201, headers });
  }

  @Patch("/invalid-state")
  invalidState() {
    throw new StrataAnalogHttpError(422, "invalid_product_state");
  }

  @Delete("/deleted")
  deleted() {
    return noContent({ headers: { "x-deleted": "packed-product" } });
  }
}
