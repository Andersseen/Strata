import { Controller, Get } from "@strata-sc/core";

// A route that is free on the router, used in a batch that also contains a
// duplicate: the whole batch must fail without registering it.

@Controller("/api/unregistered")
export class UnregisteredController {
  @Get()
  find() {
    return { route: "unregistered" };
  }
}
