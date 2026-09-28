import { Controller, Get } from "@strata-sc/core";

// Controller metadata is class-local: extending a controller does not inherit
// @Controller() or its @Get() routes.

@Controller("/api/base")
export class BaseController {
  @Get("/one")
  one() {
    return { route: "one" };
  }
}

export class UndecoratedChild extends BaseController {}

@Controller("/api/child")
export class DecoratedChild extends BaseController {
  @Get("/two")
  two() {
    return { route: "two" };
  }
}
