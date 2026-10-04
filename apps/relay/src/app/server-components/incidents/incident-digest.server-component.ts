import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { IncidentDigestSource, fingerprint } from "./incident-digest.source";
import { IncidentListComponent } from "./incident-list.component";

export const RELAY_INCIDENT_DIGEST_SERVER_MARKER =
  "RELAY_INCIDENT_DIGEST_SERVER_IMPLEMENTATION_5B02";

/**
 * Live data, rendered on the server: the digest reads the same repository
 * the Strata controllers write to, on every document request.
 *
 * The tree below it is ordinary Angular composition, all server-owned:
 * IncidentListComponent renders an IncidentRowComponent per active incident
 * inside `@for`, and each row (which injects a server-only runbook) marks its
 * IncidentTriageComponent `[strataClient]`. Only those triage islands reach
 * the browser; this component's surrogate hydrates them.
 */
@ServerComponent()
@Component({
  selector: "relay-incident-digest",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IncidentListComponent],
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

      <relay-incident-list [incidents]="digest.active" [environment]="digest.environment" />
    </section>
  `,
})
export class IncidentDigestServerComponent {
  protected readonly digest = inject(IncidentDigestSource).read();
  protected readonly evidence = `${fingerprint(RELAY_INCIDENT_DIGEST_SERVER_MARKER)}.${this.digest.provenance}`;
}
