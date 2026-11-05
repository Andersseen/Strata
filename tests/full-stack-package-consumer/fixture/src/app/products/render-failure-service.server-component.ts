import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { FailingRenderDependency } from "./render-failure-dependency";

@ServerComponent()
@Component({
  selector: "render-failure-service",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [FailingRenderDependency],
  template: `<p>never rendered</p>`,
})
export class RenderFailureService {
  protected readonly dependency = inject(FailingRenderDependency);
}
