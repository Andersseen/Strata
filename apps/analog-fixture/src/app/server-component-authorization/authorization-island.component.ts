import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

@Component({
  selector: "authorization-island",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    type="button"
    data-authorization-island
    (click)="clicks.update((value) => value + 1)"
  >
    Authorized {{ tenant() }} interaction {{ clicks() }}
  </button>`,
})
export class AuthorizationIslandComponent {
  readonly tenant = input.required<string>();
  protected readonly clicks = signal(0);
}
