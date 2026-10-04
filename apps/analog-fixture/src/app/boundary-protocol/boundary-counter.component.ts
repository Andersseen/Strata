import { ChangeDetectionStrategy, Component, input, linkedSignal } from "@angular/core";

/**
 * Client island with local state. The boundary protocol fixture renders two
 * of them with the same selector and the same props: each must still be its
 * own island on its own SSR host.
 */
@Component({
  selector: "boundary-counter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" (click)="increment()">Increment</button>
    <output>Count: {{ count() }}</output>`,
})
export class BoundaryCounterComponent {
  readonly start = input.required<number>();

  protected readonly count = linkedSignal(() => this.start());

  protected increment(): void {
    this.count.update((count) => count + 1);
  }
}
