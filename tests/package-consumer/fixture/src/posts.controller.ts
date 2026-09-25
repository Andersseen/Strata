import { Controller, Get } from "@strata-sc/core";

import { registerControllers, type NitroRouter, type StrataAnalogRequest } from "@strata-sc/analog";

@Controller("/api/posts")
export class PostsController {
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    return {
      id: request.params["id"],
    };
  }

  @Get()
  findAll(request: StrataAnalogRequest) {
    return {
      query: request.query,
    };
  }
}

export function registerPosts<Router extends NitroRouter>(router: Router): Router {
  return registerControllers(router, [PostsController]);
}
