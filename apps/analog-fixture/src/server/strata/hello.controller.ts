import { Controller, Get } from "@strata/core";

// Server-only by construction: only files under `src/server/` import this
// module. The production-build scan asserts it never reaches the client.
export const STRATA_SERVER_ONLY_MARKER = "STRATA_ANALOG_SERVER_ONLY_MARKER";

@Controller("/hello")
export class HelloController {
  @Get()
  hello() {
    return {
      message: "Hello from Strata",
      marker: STRATA_SERVER_ONLY_MARKER,
    };
  }
}
