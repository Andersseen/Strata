import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { RENDER_FAILURE_CANARY } from "./render-failure-dependency";

/** Renders text BEFORE the failing binding: the native result is a half-rendered document. */
@ServerComponent()
@Component({
  selector: "render-failure-template",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p id="partial-before">Rendered before the failure</p>
    <p>{{ explode() }}</p>`,
})
export class RenderFailureTemplate {
  protected explode(): string {
    throw new Error(`template failure ${RENDER_FAILURE_CANARY}`);
  }
}
