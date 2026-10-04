import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { ServerOperationsIntelligence, fingerprint } from "../server-operations-intelligence";

import { BriefingAcknowledgementComponent } from "./briefing-acknowledgement.component";

// Verified absent from Relay's browser output; only its hash is rendered.
export const RELAY_NESTED_SERVER_COMPONENT_MARKER = "RELAY_NESTED_SERVER_COMPONENT_MARKER_E05D";

/**
 * A Server Component nested inside OperationsBriefingServerComponent, and
 * also imported directly by the release page. Self-sufficient on purpose (no
 * inputs): it reads the briefing itself, so it renders the same under either
 * parent. Nested, the outer surrogate hydrates its acknowledgement island;
 * on its own, its own surrogate does.
 */
@ServerComponent()
@Component({
  selector: "relay-briefing-metadata",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BriefingAcknowledgementComponent, StrataClientBoundary],
  template: `
    <div class="island-example" [attr.data-nested-server-evidence]="evidence">
      <span>Boundary 01 · nested Server Component</span>
      <p class="nested-meta">
        Alert <code>{{ briefing.alertId }}</code> · {{ briefing.region }} ·
        {{ briefing.confidence }}% confidence
      </p>
      <relay-briefing-acknowledgement
        [alertId]="briefing.alertId"
        actionLabel="Acknowledge briefing"
        [strataClient]="{ alertId: briefing.alertId, actionLabel: 'Acknowledge briefing' }"
      />
    </div>
  `,
})
export class BriefingMetadataServerComponent {
  protected readonly briefing = inject(ServerOperationsIntelligence).getBriefing();
  protected readonly evidence = fingerprint(RELAY_NESTED_SERVER_COMPONENT_MARKER);
}
