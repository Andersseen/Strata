import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  signal,
} from "@angular/core";

import type { IncidentSeverity, IncidentStatus } from "../../../shared/operations.models";

export const RELAY_INCIDENT_TRIAGE_CLIENT_MARKER = "RELAY_INCIDENT_TRIAGE_CLIENT_ISLAND_A6C4";

export interface IncidentTriageView {
  readonly id: string;
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly service: { readonly name: string };
  readonly actions: readonly {
    readonly label: string;
    readonly status: IncidentStatus;
  }[];
}

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
      [attr.aria-label]="'Triage ' + incident().id"
      [attr.data-client-marker]="marker"
    >
      <p>{{ incident().title }} · {{ incident().service.name }}</p>
      @for (action of incident().actions; track action.status) {
        @if (
          (action.status === "monitoring" && status() === "open") ||
          (action.status === "resolved" && status() !== "resolved")
        ) {
          <button
            type="button"
            class="server-action"
            [class.secondary]="action.status === 'monitoring'"
            [disabled]="pending()"
            (click)="update(action.status)"
          >
            {{ action.label }}{{ action.status === "resolved" ? " " + incident().id : "" }}
          </button>
        }
      }
      <output class="island-output" aria-live="polite">{{ message() }}</output>
    </div>
  `,
})
export class IncidentTriageComponent {
  readonly incident = input.required<IncidentTriageView>();

  protected readonly status = linkedSignal(() => this.incident().status);
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
      const response = await fetch(`/api/ops/incidents/${encodeURIComponent(this.incident().id)}`, {
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
