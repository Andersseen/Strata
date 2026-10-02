import { ChangeDetectionStrategy, Component, input } from "@angular/core";

import type { DigestIncident } from "./incident-digest.source";
import { fingerprint } from "./incident-digest.source";
import { IncidentRowComponent } from "./incident-row.component";

// Verified absent from Relay's browser output; only its hash is rendered.
export const RELAY_SERVER_ONLY_CHILD_MARKER = "RELAY_SERVER_ONLY_CHILD_MARKER_2B5E";

/**
 * The digest's incident list. An ordinary Angular component, with no Server
 * Component decorator: rendered only by IncidentDigestServerComponent, it is
 * server-owned and never reaches the browser.
 */
@Component({
  selector: "relay-incident-list",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IncidentRowComponent],
  template: `
    <ol class="digest-list" [attr.data-server-child-evidence]="evidence">
      @for (incident of incidents(); track incident.id) {
        <li class="digest-item" [attr.data-incident]="incident.id">
          <relay-incident-row [incident]="incident" />
        </li>
      } @empty {
        <li class="digest-empty">No active incidents in {{ environment() }}.</li>
      }
    </ol>
  `,
})
export class IncidentListComponent {
  readonly incidents = input.required<readonly DigestIncident[]>();
  readonly environment = input.required<string>();

  protected readonly evidence = fingerprint(RELAY_SERVER_ONLY_CHILD_MARKER);
}
