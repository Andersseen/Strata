import { Controller, Get } from "@strata/core";

// Server-only, like `users.controller.ts`: only the Nitro plugin imports this
// module. The production-build scan asserts the marker (and so the
// controllerFactory wiring around it) never reaches the client output.
export const STRATA_ANALOG_FACTORY_MARKER = "STRATA_ANALOG_CONTROLLER_FACTORY_MARKER";

/** A plain TypeScript dependency, created by the Nitro plugin — not by Strata. */
export class GreetingService {
  greet() {
    return "hello";
  }
}

// The dependency arrives through the `controllerFactory` passed to
// `registerControllers()`. The parameter is optional only because Strata's
// default factory calls `new Controller()`; without the custom factory this
// route would answer `greeting: null`.
@Controller("/api/strata/greeting")
export class GreetingController {
  static readonly serverOnlyMarker = STRATA_ANALOG_FACTORY_MARKER;

  private calls = 0;

  constructor(private readonly greetings?: GreetingService) {}

  @Get()
  greet() {
    this.calls++;

    return { greeting: this.greetings?.greet() ?? null, calls: this.calls };
  }
}
