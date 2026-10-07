import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { SecurityProbeIslandComponent } from "./security-probe-island.component";
import { SecurityRepository } from "./security-repository";

/** Passed deliberately through `[strataClient]`: public browser data by definition. */
export const PUBLIC_CONTROL_CANARY = "STRATA_PUBLIC_CONTROL_CANARY_3C95E0A7D184";

/**
 * The security fixture's Server Component: reads a server-only repository that
 * uses a DATA canary, renders only the verdict, and hands the browser a safe
 * label plus the PUBLIC control canary through `[strataClient]`.
 */
@ServerComponent()
@Component({
  selector: "security-surface",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SecurityProbeIslandComponent, StrataClientBoundary],
  template: `<section data-security-surface>
    <h1>Server Component security</h1>
    <p data-verification>Internal verification: {{ verification }}</p>
    <security-probe
      [label]="safeLabel"
      [control]="control"
      [enabled]="true"
      [strataClient]="{ label: safeLabel, control: control, enabled: true }"
    />
  </section>`,
})
export class SecurityServerComponent {
  private readonly repository = inject(SecurityRepository);

  protected readonly safeLabel = "security-probe";
  protected readonly control = PUBLIC_CONTROL_CANARY;
  protected readonly verification = this.repository.verifyInternalConfiguration()
    ? "ready"
    : "not ready";
}
