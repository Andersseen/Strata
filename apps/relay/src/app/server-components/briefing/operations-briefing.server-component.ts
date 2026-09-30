import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { ServerOperationsIntelligence, fingerprint } from "../server-operations-intelligence";

import { BriefingAcknowledgementComponent } from "./briefing-acknowledgement.component";
import { BriefingWindowComponent } from "./briefing-window.component";

export const RELAY_BRIEFING_SERVER_MARKER = "RELAY_OPERATIONS_BRIEFING_SERVER_IMPLEMENTATION_4D18";

@ServerComponent()
@Component({
  selector: "relay-operations-briefing",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BriefingAcknowledgementComponent, BriefingWindowComponent, StrataClientBoundary],
  template: `
    <section
      class="server-example briefing-example"
      aria-labelledby="server-briefing-title"
      [attr.data-server-evidence]="evidence"
    >
      <div class="server-copy">
        <p class="server-label">SERVER COMPONENT / LIVE BRIEFING</p>
        <h2 id="server-briefing-title">{{ briefing.headline }}</h2>
        <p>{{ briefing.detail }}</p>
        <dl class="server-facts">
          <div>
            <dt>Region</dt>
            <dd>{{ briefing.region }}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{{ briefing.confidence }}%</dd>
          </div>
          <div>
            <dt>Server proof</dt>
            <dd>
              <code>{{ briefing.provenance }}</code>
            </dd>
          </div>
        </dl>
      </div>
      <div class="server-islands" aria-label="Interactive client islands">
        <div class="island-example">
          <span>Boundary 01 · flat string props</span>
          <relay-briefing-acknowledgement
            [alertId]="briefing.alertId"
            actionLabel="Acknowledge briefing"
            [strataClient]="{ alertId: briefing.alertId, actionLabel: 'Acknowledge briefing' }"
          />
        </div>
        <div class="island-example">
          <span>Boundary 02 · string + number props</span>
          <relay-briefing-window
            [initialWindow]="30"
            label="Observation window"
            [strataClient]="{ initialWindow: 30, label: 'Observation window' }"
          />
        </div>
      </div>
    </section>
  `,
})
export class OperationsBriefingServerComponent {
  private readonly intelligence = inject(ServerOperationsIntelligence);

  protected readonly briefing = this.intelligence.getBriefing();
  protected readonly evidence = `${fingerprint(RELAY_BRIEFING_SERVER_MARKER)}.${this.briefing.provenance}`;
}
