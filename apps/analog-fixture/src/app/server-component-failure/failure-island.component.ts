import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  inject,
  input,
  signal,
} from "@angular/core";

import { failureProbe, failureSwitch, islandKey } from "./failure-switch";

/**
 * Client island of the failure fixture. Its three failure points (constructor,
 * `start` input transform, click handler) are armed by a browser test through
 * `failureSwitch()`; none is armed in a normal page.
 */
@Component({
  selector: "failure-island",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" (click)="press()">Press {{ label() }}</button>
    <output>Presses: {{ presses() }}</output>`,
})
export class FailureIslandComponent {
  private readonly key = islandKey(inject(ElementRef).nativeElement as Element);

  readonly label = input.required<string>();
  readonly start = input.required<number, number>({
    transform: (value) => {
      if (failureSwitch().input === this.key) {
        throw new Error(`[fixture] injected input failure for ${this.key}`);
      }

      return value;
    },
  });

  protected readonly presses = signal(0);

  constructor() {
    if (failureSwitch().create === this.key) {
      throw new Error(`[fixture] injected create failure for ${this.key}`);
    }

    const probe = failureProbe(inject(Injector));

    if (probe) {
      probe.constructed[this.key] = (probe.constructed[this.key] ?? 0) + 1;
      inject(DestroyRef).onDestroy(() => {
        probe.destroyed[this.key] = (probe.destroyed[this.key] ?? 0) + 1;
      });
    }
  }

  protected press(): void {
    if (failureSwitch().click === this.key) {
      throw new Error(`[fixture] injected click failure for ${this.key}`);
    }

    this.presses.update((count) => count + 1);
  }
}
