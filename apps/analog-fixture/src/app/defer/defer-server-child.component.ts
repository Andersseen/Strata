import { ChangeDetectionStrategy, Component } from "@angular/core";
import { StrataClientBoundary } from "@strata-sc/server-components";

import { DeferInteractionPanelComponent } from "./defer-interaction-panel.component";
import { DeferViewportPanelComponent } from "./defer-viewport-panel.component";

// Emitted only by this server-owned child: it must stay out of the browser.
// Rendered only as its length, so the HTML never carries it.
const SERVER_CHILD_MARKER = "STRATA_DEFER_SERVER_CHILD_MARKER";

/**
 * Ordinary component, server-owned because DeferShowcaseServerComponent
 * renders it. Hosts two client islands; the second sits below the fold.
 */
@Component({
  selector: "defer-server-child",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DeferInteractionPanelComponent, DeferViewportPanelComponent, StrataClientBoundary],
  template: `<div [attr.data-evidence]="marker.length">
    <defer-interaction-panel [label]="'Rollout'" [strataClient]="{ label: 'Rollout' }" />
    <div data-spacer style="height: 2400px">Below the fold</div>
    <defer-viewport-panel [strataClient]="{}" />
  </div>`,
})
export class DeferServerChildComponent {
  protected readonly marker = SERVER_CHILD_MARKER;
}
