import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

/** Client island C of the dev gate: swapped in and out of `dev-boundary` while Vite runs. */
@Component({
  selector: "dev-island-c",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" data-dev-island-c (click)="bump()">Island C</button>
    <output data-dev-island-c-count>C clicks: {{ count() }}</output>`,
})
export class DevIslandCComponent {
  protected readonly count = signal(0);

  protected bump(): void {
    this.count.update((count) => count + 1);
  }
}
