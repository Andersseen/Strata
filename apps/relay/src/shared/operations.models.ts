export type Environment = "production" | "staging";
export type ServiceStatus = "healthy" | "degraded" | "investigating";
export type IncidentStatus = "open" | "monitoring" | "resolved";
export type IncidentSeverity = "critical" | "high" | "medium" | "low";

export interface Service {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly owner: string;
  readonly environment: Environment;
  readonly status: ServiceStatus;
  readonly availability: number;
  readonly latencyMs: number;
  readonly version: string;
  readonly updatedAt: string;
}

export interface Incident {
  readonly id: string;
  readonly title: string;
  readonly serviceId: string;
  readonly environment: Environment;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly startedAt: string;
  readonly assignee: string;
  readonly summary: string;
}

export interface ActivityItem {
  readonly id: string;
  readonly kind: "deploy" | "incident" | "recovery";
  readonly title: string;
  readonly detail: string;
  readonly environment: Environment;
  readonly occurredAt: string;
}

export interface OperationsSnapshot {
  readonly services: readonly Service[];
  readonly incidents: readonly Incident[];
  readonly activity: readonly ActivityItem[];
  readonly request: {
    readonly correlationId: string;
    readonly completedScopes: number;
  };
}

export interface CreateIncidentInput {
  readonly title: string;
  readonly serviceId: string;
  readonly environment: Environment;
  readonly severity: IncidentSeverity;
  readonly summary: string;
}

export interface UpdateIncidentInput {
  readonly status: IncidentStatus;
}
