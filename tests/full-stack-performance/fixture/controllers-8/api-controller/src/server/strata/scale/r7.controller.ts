import { Controller, Delete, Get, Post } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

import { ITEM_INPUT, PRIVATE_FAILURE, findScaleItem, scaleAnswer } from "../../scale/domain";
import { SCALE_CONTROLLER_MARKER, ledgerFor } from "./ledger";

@Controller("/api/scale/r7")
export class ScaleR7Controller {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    const item = findScaleItem(ledgerFor(request), request.params["id"] ?? "");

    return item
      ? scaleAnswer(200, item, SCALE_CONTROLLER_MARKER)
      : scaleAnswer(404, { error: "not_found" }, SCALE_CONTROLLER_MARKER);
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    const input = await request.readValidatedJson(ITEM_INPUT);

    ledgerFor(request).read();

    return scaleAnswer(201, { resource: "r7", ...input }, SCALE_CONTROLLER_MARKER);
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    ledgerFor(request).read();

    return scaleAnswer(200, { deleted: request.params["id"] }, SCALE_CONTROLLER_MARKER);
  }

  @Get("/:id/fail")
  fail(): never {
    throw new Error(PRIVATE_FAILURE);
  }
}
