import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

import { countDeferProbe } from "./defer-probe";

// Emitted only by this deferred dependency: it must sit in a lazy browser chunk.
const INTERACTION_WIDGET_MARKER = "STRATA_DEFER_INTERACTION_WIDGET_MARKER";

/**
 * Deferred dependency of DeferInteractionPanelComponent, behind
 * `hydrate on interaction`. The click that triggers its hydration is also
 * the click that must count (Angular event replay).
 */
@Component({
  selector: "defer-interaction-widget",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" [attr.data-marker]="marker" (click)="expand()">
      Show rollout details
    </button>
    <output>Expanded: {{ expansions() }}</output>`,
})
export class DeferInteractionWidgetComponent {
  protected readonly marker = INTERACTION_WIDGET_MARKER;
  protected readonly expansions = signal(0);

  constructor() {
    countDeferProbe("interactionWidget");
  }

  protected expand(): void {
    this.expansions.update((count) => count + 1);
  }
}
