import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

/**
 * A Server Component with no client boundary at first. The dev gate adds,
 * swaps and removes boundaries by editing this file while Vite runs.
 */
@ServerComponent()
@Component({
  selector: "dev-boundary",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<aside data-dev-boundary>Boundary host</aside>`,
})
export class DevBoundaryServerComponent {}
