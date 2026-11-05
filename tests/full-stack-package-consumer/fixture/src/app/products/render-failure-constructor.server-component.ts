import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { RENDER_FAILURE_CANARY } from "./render-failure-dependency";

@ServerComponent()
@Component({
  selector: "render-failure-constructor",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p>never rendered</p>`,
})
export class RenderFailureConstructor {
  constructor() {
    throw new Error(`constructor failure ${RENDER_FAILURE_CANARY}`);
  }
}
