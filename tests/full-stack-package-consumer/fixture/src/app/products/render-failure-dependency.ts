import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

/**
 * Deterministic UNEXPECTED render failures for the SSR failure contract (render-failure-status.ts).
 * Each message carries a private canary that must stay in the server log.
 */
export const RENDER_FAILURE_CANARY = "RENDER_FAILURE_PRIVATE_5c1e";

@Injectable()
export class FailingRenderDependency {
  constructor() {
    throw new Error(`dependency unavailable ${RENDER_FAILURE_CANARY}`);
  }
}
