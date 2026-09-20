import { Controller, Get } from "@strata/core";

// Server-only by construction, like `hello.controller.ts`: only the Nitro
// plugin under `src/server/plugins/` imports this module, and it registers the
// controller through `@strata/analog` — there is deliberately no file-system
// route wrapper. The production-build scan asserts the marker reaches the
// server output and never the client output.
export const STRATA_ANALOG_CONTROLLER_MARKER = "STRATA_ANALOG_REGISTERED_CONTROLLER_MARKER";

@Controller("/api/strata/users")
export class UsersController {
  static readonly serverOnlyMarker = STRATA_ANALOG_CONTROLLER_MARKER;

  @Get()
  findAll() {
    return [{ id: "1", name: "Ada" }];
  }

  // Routing only: no parameter extraction exists yet, so this always answers
  // with the same user — it proves `/:id` is registered as a dynamic route.
  @Get("/:id")
  findOne() {
    return { id: "1", name: "Ada" };
  }
}
