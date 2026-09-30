import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  signal,
} from "@angular/core";

import type { IncidentStatus } from "../../../shared/operations.models";

export const RELAY_INCIDENT_TRIAGE_CLIENT_MARKER = "RELAY_INCIDENT_TRIAGE_CLIENT_ISLAND_A6C4";

/**
 * One client island per incident in the server-rendered digest. It mutates
 * through the Strata controller (`PATCH /api/ops/incidents/:id`); the next
 * document request re-renders the digest on the server from the same store.
 */
@Component({
  selector: "relay-incident-triage",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="triage-control"
      role="group"
      [attr.aria-label]="'Triage ' + incidentId()"
      [attr.data-client-marker]="marker"
    >
      @if (status() === "open") {
        <button
          type="button"
          class="server-action secondary"
          [disabled]="pending()"
          (click)="update('monitoring')"
        >
          Start monitoring
        </button>
      }
      @if (status() !== "resolved") {
        <button
          type="button"
          class="server-action"
          [disabled]="pending()"
          (click)="update('resolved')"
        >
          Resolve {{ incidentId() }}
        </button>
      }
      <output class="island-output" aria-live="polite">{{ message() }}</output>
    </div>
  `,
})
export class IncidentTriageComponent {
  readonly incidentId = input.required<string>();
  readonly initialStatus = input.required<IncidentStatus>();

  protected readonly status = linkedSignal(() => this.initialStatus());
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly marker = RELAY_INCIDENT_TRIAGE_CLIENT_MARKER;
  protected readonly message = computed(() => {
    if (this.error()) return this.error();
    if (this.pending()) return "Saving through the controller…";
    return `Status: ${this.status()}`;
  });

  protected async update(status: IncidentStatus): Promise<void> {
    this.pending.set(true);
    this.error.set(null);

    try {
      const response = await fetch(`/api/ops/incidents/${encodeURIComponent(this.incidentId())}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-relay-request": crypto.randomUUID() },
        body: JSON.stringify({ status }),
      });
      const body = (await response.json()) as { incident: { status: IncidentStatus } | null };

      if (!response.ok || !body.incident) throw new Error(`HTTP ${response.status}`);
      this.status.set(body.incident.status);
    } catch (error) {
      this.error.set(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.pending.set(false);
    }
  }
}
