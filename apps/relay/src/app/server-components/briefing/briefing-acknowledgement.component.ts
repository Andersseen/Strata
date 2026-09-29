import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

export const RELAY_BRIEFING_CLIENT_MARKER = "RELAY_BRIEFING_CLIENT_ISLAND_2A91";

@Component({
  selector: "relay-briefing-acknowledgement",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="server-action" [disabled]="acknowledged()" (click)="acknowledge()">
      {{ acknowledged() ? "Acknowledged locally" : actionLabel() }}
    </button>
    <output class="island-output" [attr.data-client-marker]="marker">
      {{ acknowledged() ? "Client island handled the interaction." : "Waiting for operator." }}
    </output>
  `,
})
export class BriefingAcknowledgementComponent {
  readonly alertId = input.required<string>();
  readonly actionLabel = input.required<string>();

  protected readonly acknowledged = signal(false);
  protected readonly marker = RELAY_BRIEFING_CLIENT_MARKER;

  protected acknowledge(): void {
    this.acknowledged.set(true);
  }
}
