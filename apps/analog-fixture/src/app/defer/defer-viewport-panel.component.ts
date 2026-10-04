import { ChangeDetectionStrategy, Component } from "@angular/core";

import { countDeferProbe } from "./defer-probe";
import { DeferViewportWidgetComponent } from "./defer-viewport-widget.component";

/**
 * Client island (`[strataClient]`) below the fold, whose own `@defer` block
 * hydrates when it enters the viewport. Angular owns that trigger.
 */
@Component({
  selector: "defer-viewport-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DeferViewportWidgetComponent],
  template: `@defer (on viewport; hydrate on viewport) {
      <defer-viewport-widget />
    } @placeholder {
      <p>Acknowledgement pending</p>
    }`,
})
export class DeferViewportPanelComponent {
  constructor() {
    countDeferProbe("panel");
  }
}
