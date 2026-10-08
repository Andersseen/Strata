import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

/** Client island B of the dev gate: swapped in and out of `dev-boundary` while Vite runs. */
@Component({
  selector: "dev-island-b",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" data-dev-island-b (click)="bump()">Island B</button>
    <output data-dev-island-b-count>B clicks: {{ count() }}</output>`,
})
export class DevIslandBComponent {
  protected readonly count = signal(0);

  protected bump(): void {
    this.count.update((count) => count + 1);
  }
}
