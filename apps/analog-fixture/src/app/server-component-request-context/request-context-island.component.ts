import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

@Component({
  selector: "request-context-island",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    type="button"
    data-request-context-island
    (click)="clicks.update((value) => value + 1)"
  >
    client-ready {{ clicks() }}
  </button>`,
})
export class RequestContextIslandComponent {
  protected readonly clicks = signal(0);
}
