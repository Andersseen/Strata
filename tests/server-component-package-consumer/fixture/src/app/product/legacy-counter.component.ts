import { ChangeDetectionStrategy, Component, input, linkedSignal } from "@angular/core";

@Component({
  selector: "legacy-counter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" (click)="increment()">Legacy v1 counter</button>
    <output>Legacy count: {{ count() }}</output>`,
})
export class LegacyCounterComponent {
  readonly start = input.required<number>();
  protected readonly count = linkedSignal(() => this.start());

  protected increment(): void {
    this.count.update((value) => value + 1);
  }
}
