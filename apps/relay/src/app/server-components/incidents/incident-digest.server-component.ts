import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { IncidentDigestSource, fingerprint } from "./incident-digest.source";
import { IncidentTriageComponent } from "./incident-triage.component";

export const RELAY_INCIDENT_DIGEST_SERVER_MARKER =
  "RELAY_INCIDENT_DIGEST_SERVER_IMPLEMENTATION_5B02";

/**
 * Live data, rendered on the server: the digest reads the same repository
 * the Strata controllers write to, on every document request. Each active
 * incident carries its own `[strataClient]` island, rendered inside `@for`.
 */
@ServerComponent()
@Component({
  selector: "relay-incident-digest",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IncidentTriageComponent, StrataClientBoundary],
  template: `
    <section
      class="incident-digest"
      aria-labelledby="incident-digest-title"
      [attr.data-server-evidence]="evidence"
    >
      <header class="digest-header">
        <div>
          <p class="server-label">SERVER COMPONENT / LIVE REPOSITORY</p>
          <h2 id="incident-digest-title">
            {{ digest.active.length }} active
            {{ digest.active.length === 1 ? "incident" : "incidents" }} in {{ digest.environment }}
          </h2>
          <p>
            Rendered from the controllers' in-memory store during this request.
            {{ digest.resolvedCount }} resolved.
          </p>
        </div>
        <dl class="server-facts">
          <div>
            <dt>Degraded services</dt>
            <dd>
              @for (service of digest.degradedServices; track service.id; let last = $last) {
                {{ service.name }} ({{ service.status }}){{ last ? "" : ", " }}
              } @empty {
                none
              }
            </dd>
          </div>
          <div>
            <dt>Server proof</dt>
            <dd>
              <code>{{ digest.provenance }}</code>
            </dd>
          </div>
        </dl>
      </header>

      <ol class="digest-list">
        @for (incident of digest.active; track incident.id) {
          <li class="digest-item" [attr.data-incident]="incident.id">
            <div class="digest-copy">
              <p class="digest-meta">
                <span class="severity" [attr.data-severity]="incident.severity">{{
                  incident.severity
                }}</span>
                {{ incident.id }} · {{ incident.serviceName }} · {{ incident.assignee }}
              </p>
              <h3>{{ incident.title }}</h3>
              <p>{{ incident.summary }}</p>
            </div>
            <relay-incident-triage
              [incidentId]="incident.id"
              [initialStatus]="incident.status"
              [strataClient]="{ incidentId: incident.id, initialStatus: incident.status }"
            />
          </li>
        } @empty {
          <li class="digest-empty">No active incidents in {{ digest.environment }}.</li>
        }
      </ol>
    </section>
  `,
})
export class IncidentDigestServerComponent {
  protected readonly digest = inject(IncidentDigestSource).read();
  protected readonly evidence = `${fingerprint(RELAY_INCIDENT_DIGEST_SERVER_MARKER)}.${this.digest.provenance}`;
}
