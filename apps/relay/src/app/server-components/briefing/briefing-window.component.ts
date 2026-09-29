import { ChangeDetectionStrategy, Component, input, linkedSignal } from "@angular/core";

export const RELAY_BRIEFING_WINDOW_CLIENT_MARKER = "RELAY_BRIEFING_WINDOW_CLIENT_ISLAND_68B4";

@Component({
  selector: "relay-briefing-window",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="window-picker"
      role="group"
      [attr.aria-label]="label()"
      [attr.data-client-marker]="marker"
    >
      @for (window of windows; track window) {
        <button
          type="button"
          [class.active]="selected() === window"
          [attr.aria-pressed]="selected() === window"
          (click)="selected.set(window)"
        >
          {{ window }}m
        </button>
      }
    </div>
    <output class="island-output">Client window: {{ selected() }} minutes</output>
  `,
})
export class BriefingWindowComponent {
  readonly initialWindow = input.required<number>();
  readonly label = input.required<string>();

  protected readonly windows = [15, 30, 60] as const;
  protected readonly selected = linkedSignal(() => this.initialWindow());
  protected readonly marker = RELAY_BRIEFING_WINDOW_CLIENT_MARKER;
}
