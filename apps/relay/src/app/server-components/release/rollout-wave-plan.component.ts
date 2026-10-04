import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";

export const RELAY_ROLLOUT_WAVE_PLAN_MARKER = "RELAY_ROLLOUT_WAVE_PLAN_DEFERRED_5C3A";

const WAVE_PERCENTS = [5, 10, 25, 50];

/**
 * Secondary detail of the rollout island, behind Angular's `@defer (hydrate on
 * interaction)` in RolloutSimulatorComponent: server-rendered, its code in a
 * lazy chunk fetched on the first interaction. It reads only the island's
 * server props, never the slider, so its dehydrated SSR markup is never stale.
 */
@Component({
  selector: "relay-rollout-wave-plan",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rollout-waves" [attr.data-client-marker]="marker">
      <span>Wave plan</span>
      <ol>
        @for (wave of waves(); track wave.percent) {
          <li>{{ wave.percent }}% · {{ wave.rpm }} req/min</li>
        }
      </ol>
      <button type="button" class="server-action" (click)="pinned.update((value) => !value)">
        {{ pinned() ? "Wave plan pinned" : "Pin wave plan" }}
      </button>
    </div>
  `,
})
export class RolloutWavePlanComponent {
  readonly maxPercent = input.required<number>();
  readonly baselineRpm = input.required<number>();

  protected readonly pinned = signal(false);
  protected readonly marker = RELAY_ROLLOUT_WAVE_PLAN_MARKER;
  protected readonly waves = computed(() =>
    WAVE_PERCENTS.filter((percent) => percent <= this.maxPercent()).map((percent) => ({
      percent,
      rpm: Math.round((this.baselineRpm() * percent) / 100),
    })),
  );
}
