import { ChangeDetectionStrategy, Component, input, linkedSignal } from "@angular/core";

/**
 * An ordinary application invariant, enforced by an Angular input transform. The server always
 * renders `start: 0`; the commit-rollback qualification rewrites one host's document to carry
 * `-1`, which passes Strata's preflight (a finite number) and fails inside `setInput` during the
 * commit, after the host's earlier islands were already created.
 */
function nonNegative(value: number): number {
  if (value < 0) throw new Error("legacy-counter start must not be negative");
  return value;
}

@Component({
  selector: "legacy-counter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" (click)="increment()">Legacy v1 counter</button>
    <output>Legacy count: {{ count() }}</output>`,
})
export class LegacyCounterComponent {
  readonly start = input.required<number, number>({ transform: nonNegative });
  protected readonly count = linkedSignal(() => this.start());

  protected increment(): void {
    this.count.update((value) => value + 1);
  }
}
