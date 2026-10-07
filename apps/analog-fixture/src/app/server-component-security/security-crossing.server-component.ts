import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import type { ClientBoundaryProps } from "@strata-sc/server-components";

import { SecurityProbeIslandComponent } from "./security-probe-island.component";
import { SecurityRepository } from "./security-repository";
import { SECURITY_SCENARIO } from "./security-scenario";

/**
 * Test-only negative: a cast smuggles a value that is not boundary data into
 * `[strataClient]`. The runtime validation must reject it before anything is
 * serialized, and the diagnostic must not print the value.
 *
 *  - `repository`: the repository instance itself (its own property holds the
 *    DATA canary, so a serializer that walked it would emit it)
 *  - `nested`: a plain nested object containing the DATA canary
 */
@ServerComponent()
@Component({
  selector: "security-crossing",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SecurityProbeIslandComponent, StrataClientBoundary],
  template: `<security-probe
    [label]="'crossing'"
    [control]="'none'"
    [enabled]="true"
    [strataClient]="props"
  />`,
})
export class SecurityCrossingServerComponent {
  private readonly repository = inject(SecurityRepository);
  private readonly mode = inject(SECURITY_SCENARIO);

  protected readonly props = {
    label: "crossing",
    [this.mode === "nested" ? "configuration" : "repository"]:
      this.mode === "nested" ? this.repository.describeConfiguration() : this.repository,
  } as unknown as ClientBoundaryProps;
}
