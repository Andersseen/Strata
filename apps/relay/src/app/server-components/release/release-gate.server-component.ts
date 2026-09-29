import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { ServerOperationsIntelligence } from "../server-operations-intelligence";

import { RolloutSimulatorComponent } from "./rollout-simulator.component";

export const RELAY_RELEASE_SERVER_MARKER = "RELAY_RELEASE_GATE_SERVER_IMPLEMENTATION_1F37";

@ServerComponent()
@Component({
  selector: "relay-release-gate",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RolloutSimulatorComponent, StrataClientBoundary],
  template: `
    <article class="release-gate" [attr.data-server-evidence]="evidence">
      <div class="release-assessment">
        <p class="server-label">SERVER COMPONENT / RELEASE ASSESSMENT</p>
        <h2>
          {{ assessment.service }} <span>{{ assessment.version }}</span>
        </h2>
        <div class="risk-score">
          <strong>{{ assessment.riskScore }}</strong
          ><span>/ 100 risk</span>
        </div>
        <h3>{{ assessment.recommendation }}</h3>
        <p>{{ assessment.reason }}</p>
        <dl class="server-facts">
          <div>
            <dt>Computed</dt>
            <dd>during SSR</dd>
          </div>
          <div>
            <dt>Browser implementation</dt>
            <dd>surrogate only</dd>
          </div>
          <div>
            <dt>Server proof</dt>
            <dd>
              <code>{{ assessment.provenance }}</code>
            </dd>
          </div>
        </dl>
      </div>
      <div class="release-boundary">
        <p class="server-label">CLIENT BOUNDARY / SERIALIZED PROPS</p>
        <relay-rollout-simulator
          [service]="assessment.service"
          [version]="assessment.version"
          [maxPercent]="25"
          [baselineRpm]="4800"
          [strataClient]="{
            service: assessment.service,
            version: assessment.version,
            maxPercent: 25,
            baselineRpm: 4800,
          }"
        />
      </div>
    </article>
  `,
})
export class ReleaseGateServerComponent {
  private readonly intelligence = inject(ServerOperationsIntelligence);

  protected readonly assessment = this.intelligence.assessRelease();
  protected readonly evidence = `${RELAY_RELEASE_SERVER_MARKER}:${this.assessment.provenance}`;
}
