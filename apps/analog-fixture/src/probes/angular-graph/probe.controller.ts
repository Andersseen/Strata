import { Controller, Get } from "@strata-sc/core";

// Consumer-authored standard decorators inside the Angular-compiled graph
// (imported by a page, so it is part of both the SSR and the client build).
// It intentionally carries no server-only marker. Only built by the probe
// configuration (vite.probe.config.ts), never by the baseline build.
@Controller("/probe")
export class ProbeController {
  @Get()
  probe() {
    return { source: "angular-graph" };
  }
}
