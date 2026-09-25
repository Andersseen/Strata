import { Controller, Get } from "@strata-sc/core";

// Holds per-instance state on purpose: `@strata-sc/analog` creates a new
// controller for every request, so each request must observe `calls: 1`. A
// shared instance would answer 1, 2, 3… across requests.
@Controller("/api/strata/lifecycle")
export class LifecycleController {
  private calls = 0;

  @Get()
  handle() {
    this.calls++;

    return { calls: this.calls };
  }
}
