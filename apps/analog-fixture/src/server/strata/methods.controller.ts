import { Controller, Delete, Get, Patch, Post, Put } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

interface NamedBody {
  readonly name: string;
}

// One route per HTTP method, registered through `@strata-sc/analog` by the
// Nitro plugin. `test:analog` and the Cloudflare qualification send the same
// method table to it on Node and on workerd.
@Controller("/api/strata/methods")
export class MethodsController {
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

    return {
      handler: "update",
      method: request.method,
      id: request.params["id"],
      name: body.name,
    };
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { handler: "remove", method: request.method, deleted: request.params["id"] };
  }
}
