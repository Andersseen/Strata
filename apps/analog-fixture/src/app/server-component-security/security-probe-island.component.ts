import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

/**
 * The client island of the security fixture. It receives only what the Server
 * Component passes through `[strataClient]`: a safe label, the PUBLIC control
 * canary (a positive control: it MUST reach every public surface) and a flag.
 */
@Component({
  selector: "security-probe",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-field="label">{{ label() }}</p>
    <p data-field="control">{{ control() }}</p>
    <button type="button" [attr.data-enabled]="enabled()" (click)="ping()">
      Ping {{ label() }}
    </button>
    <output>Pings: {{ pings() }}</output>`,
})
export class SecurityProbeIslandComponent {
  readonly label = input.required<string>();
  readonly control = input.required<string>();
  readonly enabled = input.required<boolean>();

  protected readonly pings = signal(0);

  protected ping(): void {
    this.pings.update((count) => count + 1);
  }
}
