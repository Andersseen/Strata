import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from "@angular/forms";
import {
  VoltBadge,
  VoltButton,
  VoltCard,
  VoltCardContent,
  VoltCardDescription,
  VoltCardHeader,
  VoltCardTitle,
  VoltFormField,
  VoltInput,
  VoltLabel,
  VoltNativeSelect,
  VoltProgress,
  VoltProgressLabel,
  VoltProgressValue,
  VoltSeparator,
  VoltTable,
  VoltTableBody,
  VoltTableCell,
  VoltTableHead,
  VoltTableHeader,
  VoltTableRow,
} from "@voltui/components";
import { LmnArrowRightIcon } from "lumen-icons/arrow-right";
import { LmnBoltIcon } from "lumen-icons/bolt";
import { LmnCheckCircleIcon } from "lumen-icons/check-circle";
import { LmnCommandLineIcon } from "lumen-icons/command-line";

import type {
  Environment,
  Incident,
  IncidentSeverity,
  ServiceStatus,
} from "../../shared/operations.models";
import { OperationsApi } from "../operations/operations-api.service";
import { OperationsBriefingServerComponent } from "../server-components/briefing/operations-briefing.server-component";

@Component({
  selector: "relay-dashboard",
  imports: [
    ReactiveFormsModule,
    LmnArrowRightIcon,
    LmnBoltIcon,
    LmnCheckCircleIcon,
    LmnCommandLineIcon,
    VoltBadge,
    VoltButton,
    VoltCard,
    VoltCardContent,
    VoltCardDescription,
    VoltCardHeader,
    VoltCardTitle,
    VoltFormField,
    VoltInput,
    VoltLabel,
    VoltNativeSelect,
    VoltProgress,
    VoltProgressLabel,
    VoltProgressValue,
    VoltSeparator,
    VoltTable,
    VoltTableBody,
    VoltTableCell,
    VoltTableHead,
    VoltTableHeader,
    VoltTableRow,
    OperationsBriefingServerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#workspace">Skip to workspace</a>
    <div class="app-shell">
      <aside class="sidebar">
        <a class="brand" href="/" aria-label="Relay operations home">
          <span class="brand-mark"><span></span><span></span><span></span></span>
          <span>relay</span>
        </a>

        <nav aria-label="Workspace navigation">
          <p class="nav-label">Workspace</p>
          <a class="nav-item active" href="#overview" aria-current="page">
            <lmn-command-line [size]="20" /> Overview
          </a>
          <a class="nav-item" href="#services"><span class="nav-dot"></span> Services</a>
          <a class="nav-item" href="#incidents"><span class="nav-dot"></span> Incidents</a>
          <a class="nav-item" href="#activity"><span class="nav-dot"></span> Activity</a>
          <a class="nav-item" href="/release"><span class="nav-dot server"></span> Release gate</a>
        </nav>

        <div class="runtime-card">
          <span class="pulse-dot"></span>
          <div>
            <strong>{{ api.health()?.status ?? "connecting" }}</strong>
            <span>Analog native route</span>
          </div>
        </div>

        <div class="profile">
          <span class="avatar">AP</span>
          <div><strong>Andrii</strong><span>Workspace owner</span></div>
        </div>
      </aside>

      <main id="workspace" class="workspace" tabindex="-1">
        <header class="topbar">
          <div>
            <p class="eyebrow">OPERATIONS / OVERVIEW</p>
            <h1>Good morning, Andrii.</h1>
            <p>Here is what your systems are doing right now.</p>
          </div>
          <div class="topbar-actions">
            <label for="environment">Environment</label>
            <select
              id="environment"
              voltNativeSelect
              [value]="api.environment()"
              (change)="changeEnvironment($event)"
            >
              <option value="production">Production</option>
              <option value="staging">Staging</option>
            </select>
            <volt-button variant="outline" (click)="api.refresh()" [disabled]="api.loading()">
              {{ api.loading() ? "Refreshing…" : "Refresh" }}
            </volt-button>
            <volt-button (click)="showComposer.set(true)">New incident</volt-button>
          </div>
        </header>

        @if (api.error()) {
          <div class="error-banner" role="alert">
            <strong>Something went wrong.</strong> {{ api.error() }}
          </div>
        }

        <relay-operations-briefing />

        <section id="overview" class="metric-grid" aria-label="System summary">
          <volt-card>
            <volt-card-header>
              <volt-card-description>Services healthy</volt-card-description>
              <span class="metric-icon success"><lmn-check-circle [size]="20" /></span>
            </volt-card-header>
            <volt-card-content>
              <strong class="metric-value"
                >{{ api.healthyServices() }}/{{ api.snapshot()?.services?.length ?? 0 }}</strong
              >
              <span class="metric-note positive">Live service checks</span>
            </volt-card-content>
          </volt-card>
          <volt-card>
            <volt-card-header>
              <volt-card-description>Active incidents</volt-card-description>
              <span class="metric-icon warning"><lmn-bolt [size]="20" /></span>
            </volt-card-header>
            <volt-card-content>
              <strong class="metric-value">{{ api.activeIncidents().length }}</strong>
              <span class="metric-note">Across {{ api.environment() }}</span>
            </volt-card-content>
          </volt-card>
          <volt-card>
            <volt-card-header>
              <volt-card-description>Average latency</volt-card-description>
              <span class="metric-kicker">P50</span>
            </volt-card-header>
            <volt-card-content>
              <strong class="metric-value">{{ api.averageLatency() }}<small>ms</small></strong>
              <span class="metric-note">All monitored services</span>
            </volt-card-content>
          </volt-card>
          <volt-card>
            <volt-card-header>
              <volt-card-description>Request scopes closed</volt-card-description>
              <span class="metric-kicker">STRATA</span>
            </volt-card-header>
            <volt-card-content>
              <strong class="metric-value">{{
                api.snapshot()?.request?.completedScopes ?? 0
              }}</strong>
              <span class="metric-note code">{{ shortCorrelationId() }}</span>
            </volt-card-content>
          </volt-card>
        </section>

        <div class="content-grid">
          <section id="services" class="services-panel" aria-labelledby="services-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">LIVE INVENTORY</p>
                <h2 id="services-title">Services</h2>
              </div>
              <span>{{ api.snapshot()?.services?.length ?? 0 }} monitored</span>
            </div>

            <volt-card class="table-card">
              <volt-table>
                <volt-table-header>
                  <volt-table-row>
                    <volt-table-head>Service</volt-table-head>
                    <volt-table-head>Status</volt-table-head>
                    <volt-table-head>Availability</volt-table-head>
                    <volt-table-head>Latency</volt-table-head>
                    <volt-table-head><span class="sr-only">Inspect</span></volt-table-head>
                  </volt-table-row>
                </volt-table-header>
                <volt-table-body>
                  @for (service of api.snapshot()?.services ?? []; track service.id) {
                    <volt-table-row>
                      <volt-table-cell>
                        <div class="service-name">
                          <span class="service-glyph">{{ service.name.slice(0, 1) }}</span>
                          <div>
                            <strong>{{ service.name }}</strong
                            ><span>{{ service.owner }}</span>
                          </div>
                        </div>
                      </volt-table-cell>
                      <volt-table-cell
                        ><volt-badge [variant]="serviceBadge(service.status)">{{
                          service.status
                        }}</volt-badge></volt-table-cell
                      >
                      <volt-table-cell>
                        <div class="availability">
                          <span>{{ service.availability }}%</span
                          ><volt-progress [value]="service.availability"
                            ><volt-progress-label class="sr-only">Availability</volt-progress-label
                            ><volt-progress-value class="sr-only"
                          /></volt-progress>
                        </div>
                      </volt-table-cell>
                      <volt-table-cell
                        ><span class="mono">{{ service.latencyMs }} ms</span></volt-table-cell
                      >
                      <volt-table-cell
                        ><volt-button
                          variant="ghost"
                          size="icon"
                          [attr.aria-label]="'Inspect ' + service.name"
                          (click)="api.inspectService(service.id)"
                          ><lmn-arrow-right [size]="16" /></volt-button
                      ></volt-table-cell>
                    </volt-table-row>
                  }
                </volt-table-body>
              </volt-table>
              @if (!api.loading() && (api.snapshot()?.services?.length ?? 0) === 0) {
                <p class="empty-state">No services found in this environment.</p>
              }
            </volt-card>
          </section>

          <aside id="activity" class="activity-panel" aria-labelledby="activity-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">EVENT STREAM</p>
                <h2 id="activity-title">Activity</h2>
              </div>
            </div>
            <volt-card>
              <volt-card-content class="activity-list">
                @for (item of api.snapshot()?.activity ?? []; track item.id; let last = $last) {
                  <article class="activity-item">
                    <span class="event-icon" [class]="item.kind"><span></span></span>
                    <div>
                      <strong>{{ item.title }}</strong>
                      <p>{{ item.detail }}</p>
                      <time [attr.datetime]="item.occurredAt">{{
                        relativeTime(item.occurredAt)
                      }}</time>
                    </div>
                  </article>
                  @if (!last) {
                    <volt-separator />
                  }
                }
              </volt-card-content>
            </volt-card>
          </aside>
        </div>

        <section id="incidents" class="incidents-section" aria-labelledby="incidents-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">RESPONSE QUEUE</p>
              <h2 id="incidents-title">Incidents</h2>
            </div>
            <span>{{ api.activeIncidents().length }} requiring attention</span>
          </div>
          <div class="incident-grid">
            @for (incident of api.snapshot()?.incidents ?? []; track incident.id) {
              <volt-card class="incident-card">
                <volt-card-header>
                  <div class="incident-meta">
                    <volt-badge [variant]="severityBadge(incident.severity)">{{
                      incident.severity
                    }}</volt-badge
                    ><span>{{ incident.id }}</span>
                  </div>
                  <volt-card-title>{{ incident.title }}</volt-card-title>
                  <volt-card-description>{{ incident.summary }}</volt-card-description>
                </volt-card-header>
                <volt-card-content>
                  <div class="incident-footer">
                    <span>{{ serviceName(incident) }}</span
                    ><strong>{{ incident.status }}</strong>
                  </div>
                  @if (incident.status !== "resolved") {
                    <div class="incident-actions">
                      @if (incident.status === "open") {
                        <volt-button
                          variant="outline"
                          size="sm"
                          [disabled]="api.mutating()"
                          (click)="api.updateIncident(incident.id, 'monitoring')"
                          >Start monitoring</volt-button
                        >
                      }
                      <volt-button
                        variant="ghost"
                        size="sm"
                        [disabled]="api.mutating()"
                        (click)="api.updateIncident(incident.id, 'resolved')"
                        >Resolve</volt-button
                      >
                    </div>
                  }
                </volt-card-content>
              </volt-card>
            }
          </div>
        </section>

        @if (api.selectedService(); as service) {
          <div class="detail-backdrop" (click)="api.selectedService.set(null)">
            <aside
              class="detail-panel"
              aria-labelledby="service-detail-title"
              (click)="$event.stopPropagation()"
            >
              <div class="detail-header">
                <span class="service-glyph large">{{ service.name.slice(0, 1) }}</span
                ><volt-button variant="ghost" size="sm" (click)="api.selectedService.set(null)"
                  >Close</volt-button
                >
              </div>
              <p class="eyebrow">SERVICE DETAIL / {{ service.environment }}</p>
              <h2 id="service-detail-title">{{ service.name }}</h2>
              <p class="detail-description">{{ service.description }}</p>
              <volt-separator />
              <dl>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <volt-badge [variant]="serviceBadge(service.status)">{{
                      service.status
                    }}</volt-badge>
                  </dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{{ service.owner }}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd class="mono">{{ service.version }}</dd>
                </div>
                <div>
                  <dt>Latency</dt>
                  <dd>{{ service.latencyMs }} ms</dd>
                </div>
                <div>
                  <dt>Availability</dt>
                  <dd>{{ service.availability }}%</dd>
                </div>
              </dl>
              <p class="detail-note">Loaded through <code>GET /api/ops/services/:id</code></p>
            </aside>
          </div>
        }

        @if (showComposer()) {
          <div class="detail-backdrop" (click)="closeComposer()">
            <aside
              class="detail-panel composer"
              aria-labelledby="composer-title"
              (click)="$event.stopPropagation()"
            >
              <p class="eyebrow">CREATE / INCIDENT</p>
              <h2 id="composer-title">Open an incident</h2>
              <p class="detail-description">
                Give responders enough context to start investigating.
              </p>
              <form [formGroup]="incidentForm" (ngSubmit)="createIncident()">
                <volt-form-field
                  ><volt-label htmlFor="title">Title</volt-label
                  ><volt-input id="title" formControlName="title" placeholder="What is happening?"
                /></volt-form-field>
                <div class="form-row">
                  <volt-form-field
                    ><volt-label htmlFor="service">Service</volt-label
                    ><select id="service" voltNativeSelect formControlName="serviceId">
                      <option value="" disabled>Select a service</option>
                      @for (service of api.snapshot()?.services ?? []; track service.id) {
                        <option [value]="service.id">{{ service.name }}</option>
                      }
                    </select></volt-form-field
                  >
                  <volt-form-field
                    ><volt-label htmlFor="severity">Severity</volt-label
                    ><select id="severity" voltNativeSelect formControlName="severity">
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select></volt-form-field
                  >
                </div>
                <volt-form-field
                  ><volt-label htmlFor="summary">Summary</volt-label
                  ><volt-input
                    id="summary"
                    formControlName="summary"
                    placeholder="Impact and current signals"
                /></volt-form-field>
                <div class="form-actions">
                  <volt-button type="button" variant="ghost" (click)="closeComposer()"
                    >Cancel</volt-button
                  ><volt-button type="submit" [disabled]="incidentForm.invalid || api.mutating()">{{
                    api.mutating() ? "Creating…" : "Create incident"
                  }}</volt-button>
                </div>
              </form>
            </aside>
          </div>
        }
      </main>
    </div>
  `,
})
export default class DashboardPage {
  protected readonly api = inject(OperationsApi);
  protected readonly showComposer = signal(false);
  protected readonly incidentForm = new FormGroup({
    title: new FormControl("", {
      nonNullable: true,
      validators: [(control) => Validators.required(control)],
    }),
    serviceId: new FormControl("", {
      nonNullable: true,
      validators: [(control) => Validators.required(control)],
    }),
    severity: new FormControl<IncidentSeverity>("high", { nonNullable: true }),
    summary: new FormControl("", {
      nonNullable: true,
      validators: [(control) => Validators.required(control)],
    }),
  });

  constructor() {
    afterNextRender(() => void this.api.refresh());
  }

  protected changeEnvironment(event: Event): void {
    const environment = (event.target as HTMLSelectElement).value as Environment;
    void this.api.changeEnvironment(environment);
  }

  protected async createIncident(): Promise<void> {
    if (this.incidentForm.invalid) return;
    const created = await this.api.createIncident({
      ...this.incidentForm.getRawValue(),
      environment: this.api.environment(),
    });
    if (created) this.closeComposer();
  }

  protected closeComposer(): void {
    this.showComposer.set(false);
    this.incidentForm.reset({ title: "", serviceId: "", severity: "high", summary: "" });
  }

  protected shortCorrelationId(): string {
    const id = this.api.snapshot()?.request.correlationId;
    return id ? `trace ${id.slice(0, 8)}` : "waiting for request";
  }

  protected serviceName(incident: Incident): string {
    return (
      this.api.snapshot()?.services.find((service) => service.id === incident.serviceId)?.name ??
      incident.serviceId
    );
  }

  protected relativeTime(value: string): string {
    const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
    return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  }

  protected serviceBadge(status: ServiceStatus): "solid" | "outline" | "secondary" {
    if (status === "healthy") return "solid";
    return status === "degraded" ? "secondary" : "outline";
  }

  protected severityBadge(severity: IncidentSeverity): "destructive" | "secondary" | "outline" {
    if (severity === "critical" || severity === "high") return "destructive";
    return severity === "medium" ? "secondary" : "outline";
  }
}
