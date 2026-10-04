import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

import { countDeferProbe } from "./defer-probe";

// Emitted only by this deferred dependency: it must sit in a lazy browser chunk.
const VIEWPORT_WIDGET_MARKER = "STRATA_DEFER_VIEWPORT_WIDGET_MARKER";

/** Deferred dependency of DeferViewportPanelComponent, behind `hydrate on viewport`. */
@Component({
  selector: "defer-viewport-widget",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" [attr.data-marker]="marker" (click)="acknowledge()">
      Acknowledge
    </button>
    <output>Acknowledged: {{ acknowledged() }}</output>`,
})
export class DeferViewportWidgetComponent {
  protected readonly marker = VIEWPORT_WIDGET_MARKER;
  protected readonly acknowledged = signal(0);

  constructor() {
    countDeferProbe("viewportWidget");
  }

  protected acknowledge(): void {
    this.acknowledged.update((count) => count + 1);
  }
}
