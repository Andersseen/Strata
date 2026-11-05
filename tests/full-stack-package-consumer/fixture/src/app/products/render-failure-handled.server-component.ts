import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { RENDER_FAILURE_CANARY } from "./render-failure-dependency";

/**
 * A HANDLED application error: the component catches its own failure and renders a fallback. It never
 * reaches the ErrorHandler, so the contract leaves the HTTP 200 document alone.
 */
@ServerComponent()
@Component({
  selector: "render-failure-handled",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p id="render-handled">{{ availability }}</p>`,
})
export class RenderFailureHandled {
  protected readonly availability = RenderFailureHandled.read();

  private static read(): string {
    try {
      throw new Error(`optional data unavailable ${RENDER_FAILURE_CANARY}`);
    } catch {
      return "Availability is temporarily unknown";
    }
  }
}
