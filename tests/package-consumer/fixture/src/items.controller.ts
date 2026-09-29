import { Controller, Delete, Get, Patch, Post, Put } from "@strata-sc/core";

import type { StrataAnalogRequest } from "@strata-sc/analog";

interface NamedBody {
  readonly name: string;
}

@Controller("/api/items")
export class ItemsController {
  @Get()
  list(request: StrataAnalogRequest) {
    return { handler: "list", method: request.method };
  }

  @Post()
  async create(request: StrataAnalogRequest) {
    const body = await request.readJson<NamedBody>();

    return { handler: "create", method: request.method, name: body.name };
  }

  @Put("/:id")
  replace(request: StrataAnalogRequest) {
    return { handler: "replace", method: request.method, id: request.params["id"] };
  }

  @Patch("/:id")
  async update(request: StrataAnalogRequest) {
    const body = await request.readJson<NamedBody>();

    return { handler: "update", id: request.params["id"], name: body.name };
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { handler: "remove", method: request.method, deleted: request.params["id"] };
  }
}

/** Same path and method as `ItemsController.create`: must be rejected. */
@Controller("/api/items")
export class DuplicateCreateController {
  @Post()
  create() {}
}
