import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RESPONSE } from "@analogjs/router/tokens";
import { ServerComponent } from "@strata-sc/server-components";

import { RENDER_FAILURE_CANARY } from "./render-failure-dependency";

/**
 * Sets a private response header during the render, then fails: the failure response must not carry
 * a header the failed render wrote.
 */
@ServerComponent()
@Component({
  selector: "render-failure-header",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p id="partial-before">Rendered before the failure</p>
    <p>{{ explode() }}</p>`,
})
export class RenderFailureHeader {
  constructor() {
    const response = inject(RESPONSE, { optional: true });
    response?.setHeader("x-render-private", RENDER_FAILURE_CANARY);
    response?.setHeader("cache-control", "public, max-age=600");
  }

  protected explode(): string {
    throw new Error(`header failure ${RENDER_FAILURE_CANARY}`);
  }
}
