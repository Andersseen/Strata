import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { StrataClientBoundary } from "@strata-sc/server-components";

import type { DigestIncident } from "./incident-digest.source";
import { fingerprint } from "./incident-digest.source";
import { IncidentRunbook } from "./incident-runbook";
import { IncidentTriageComponent } from "./incident-triage.component";

// Verified absent from Relay's browser output; only its hash is rendered.
export const RELAY_SERVER_ONLY_GRANDCHILD_MARKER = "RELAY_SERVER_ONLY_GRANDCHILD_MARKER_84F2";

/**
 * One incident row. An ordinary Angular component, with no Server Component
 * decorator: it is server-owned because IncidentDigestServerComponent renders
 * it (through IncidentListComponent). It injects a server-only runbook and
 * hosts the incident's `[strataClient]` triage island, the only part of the
 * row that reaches the browser.
 */
@Component({
  selector: "relay-incident-row",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IncidentTriageComponent, StrataClientBoundary],
  template: `
    <div class="digest-copy" [attr.data-server-grandchild-evidence]="evidence">
      <p class="digest-meta">
        <span class="severity" [attr.data-severity]="incident().severity">{{
          incident().severity
        }}</span>
        {{ incident().id }} · {{ incident().serviceName }} · {{ incident().assignee }}
      </p>
      <h3>{{ incident().title }}</h3>
      <p>{{ incident().summary }}</p>
      <p class="digest-runbook" [attr.data-runbook]="guidance().provenance">
        Runbook: {{ guidance().step }}
      </p>
    </div>
    <relay-incident-triage
      [incidentId]="incident().id"
      [initialStatus]="incident().status"
      [strataClient]="{ incidentId: incident().id, initialStatus: incident().status }"
    />
  `,
})
export class IncidentRowComponent {
  readonly incident = input.required<DigestIncident>();

  private readonly runbook = inject(IncidentRunbook);

  protected readonly guidance = computed(() => this.runbook.guidanceFor(this.incident()));
  protected readonly evidence = fingerprint(RELAY_SERVER_ONLY_GRANDCHILD_MARKER);
}
