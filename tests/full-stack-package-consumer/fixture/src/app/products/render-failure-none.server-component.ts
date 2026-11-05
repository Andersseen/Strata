import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

/** Healthy control rendered by the same page and the same wrapper. */
@ServerComponent()
@Component({
  selector: "render-failure-none",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p id="render-healthy">Rendered without failure</p>`,
})
export class RenderFailureNone {}
