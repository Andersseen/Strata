import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { SECURITY_SCENARIO } from "./security-scenario";
import { SecurityRepository } from "./security-repository";
import type { SecurityFailure } from "./security-repository";

/**
 * Test-only: the server-only repository throws an error that carries the DATA
 * canary (plain, `cause` or `AggregateError`, from the route's `:mode`).
 * The production response must not.
 */
@ServerComponent()
@Component({
  selector: "security-failure",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-security-failure>unreachable: {{ outcome }}</p>`,
})
export class SecurityFailureServerComponent {
  private readonly repository = inject(SecurityRepository);
  private readonly mode = inject(SECURITY_SCENARIO);

  protected readonly outcome = this.repository.failInternally(this.mode as SecurityFailure);
}
