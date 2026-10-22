import "@strata-sc/server-components/server-only";
import { ChangeDetectionStrategy, Component } from "@angular/core";

/**
 * An Angular package component that is NOT browser-safe: it asserts
 * server-only. Registering it in `clientComponents` authorizes the component
 * reference, never a server-only dependency, so using it as a client island
 * must fail the client build.
 */
@Component({
  selector: "acme-leaky-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p>leaky</p>`,
})
export class LeakyPickerComponent {}
