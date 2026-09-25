import { Controller, Get } from "@strata-sc/core";
import type { StrataAnalogRequest } from "@strata-sc/analog";

// Server-only by construction, like `hello.controller.ts`: only the Nitro
// plugin under `src/server/plugins/` imports this module, and it registers the
// controller through `@strata-sc/analog` — there is deliberately no file-system
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

  // Request input is provided by @strata-sc/analog's own boundary, not by exposing
  // Nitro's H3 event to the controller.
  @Get("/:id")
  findOne(request: StrataAnalogRequest) {
    return { id: request.params["id"], name: "Ada" };
  }
}
