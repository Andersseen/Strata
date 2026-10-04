import { Injectable } from "@angular/core";

import type { DigestIncident } from "./incident-digest.source";
import { fingerprint } from "./incident-digest.source";

// Verified absent from Relay's browser output. Reached only by injection from
// IncidentRowComponent, an ordinary component two levels below the Server
// Component: server ownership is transitive through plain Angular children.
export const RELAY_SERVER_CHILD_DEPENDENCY_MARKER = "RELAY_SERVER_CHILD_DEPENDENCY_MARKER_C719";

const ESCALATION: Readonly<Record<DigestIncident["severity"], string>> = {
  critical: "Page the incident commander now",
  high: "Escalate to the owning team within 15 minutes",
  medium: "Review during the next triage rotation",
  low: "Track in the backlog",
};

/**
 * Server-only runbook lookup. It stands in for an internal playbook service
 * a real console would keep out of the browser.
 */
@Injectable({ providedIn: "root" })
export class IncidentRunbook {
  guidanceFor(incident: DigestIncident): { readonly step: string; readonly provenance: string } {
    return {
      step: ESCALATION[incident.severity],
      provenance: fingerprint(`${RELAY_SERVER_CHILD_DEPENDENCY_MARKER}:${incident.severity}`),
    };
  }
}
