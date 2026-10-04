import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";

import { RolloutWavePlanComponent } from "./rollout-wave-plan.component";

export const RELAY_ROLLOUT_CLIENT_MARKER = "RELAY_ROLLOUT_CLIENT_ISLAND_91E3";

/**
 * Client island of the release gate. Strata hydrates this root; the wave plan
 * inside is Angular's own `@defer` block, incrementally hydrated on the first
 * interaction with it.
 */
@Component({
  selector: "relay-rollout-simulator",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RolloutWavePlanComponent],
  template: `
    <div class="rollout-control" [attr.data-client-marker]="marker">
      <div>
        <span>Interactive island</span>
        <strong>{{ service() }} {{ version() }}</strong>
      </div>
      <label for="rollout-percent">Canary allocation</label>
      <input
        id="rollout-percent"
        type="range"
        min="0"
        [max]="maxPercent()"
        step="5"
        [value]="percent()"
        (input)="changePercent($event)"
      />
      <output>{{ percent() }}% · {{ projectedRequests() }} req/min projected</output>
      <button
        type="button"
        class="server-action"
        [disabled]="percent() === 0"
        (click)="launched.set(true)"
      >
        {{ launched() ? "Canary simulated" : "Simulate rollout" }}
      </button>
      @defer (on interaction; hydrate on interaction) {
        <relay-rollout-wave-plan [maxPercent]="maxPercent()" [baselineRpm]="baselineRpm()" />
      } @placeholder {
        <button type="button" class="server-action">Show wave plan</button>
      }
    </div>
  `,
})
export class RolloutSimulatorComponent {
  readonly service = input.required<string>();
  readonly version = input.required<string>();
  readonly maxPercent = input.required<number>();
  readonly baselineRpm = input.required<number>();

  protected readonly percent = signal(10);
  protected readonly launched = signal(false);
  protected readonly marker = RELAY_ROLLOUT_CLIENT_MARKER;
  protected readonly projectedRequests = computed(() =>
    Math.round((this.baselineRpm() * this.percent()) / 100),
  );

  protected changePercent(event: Event): void {
    this.percent.set(Number((event.target as HTMLInputElement).value));
    this.launched.set(false);
  }
}
