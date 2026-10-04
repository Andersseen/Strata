import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import { DeferInteractionWidgetComponent } from "./defer-interaction-widget.component";
import { countDeferProbe } from "./defer-probe";

// Emitted by the client island itself: it must reach the browser output.
const PANEL_MARKER = "STRATA_DEFER_CLIENT_PANEL_MARKER";

/**
 * Client island (`[strataClient]`) whose own template owns an Angular
 * `@defer` block. Strata hydrates this root; Angular owns the block's
 * incremental hydration. Strata never inspects this template.
 */
@Component({
  selector: "defer-interaction-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DeferInteractionWidgetComponent],
  template: `<h2 [attr.data-marker]="marker">{{ label() }}</h2>
    @defer (on interaction; hydrate on interaction) {
      <defer-interaction-widget />
    } @placeholder {
      <button type="button">Load rollout details</button>
    }`,
})
export class DeferInteractionPanelComponent {
  readonly label = input.required<string>();

  protected readonly marker = PANEL_MARKER;

  constructor() {
    countDeferProbe("panel");
  }
}
