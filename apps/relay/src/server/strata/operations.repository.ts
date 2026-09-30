import type {
  ActivityItem,
  CreateIncidentInput,
  Environment,
  Incident,
  IncidentStatus,
  Service,
} from "../../shared/operations.models";

import { processSingleton } from "./process-singleton";

const services: Service[] = [
  {
    id: "checkout",
    name: "Checkout API",
    description: "Payment intents, tax calculation and order confirmation.",
    owner: "Revenue Platform",
    environment: "production",
    status: "degraded",
    availability: 99.91,
    latencyMs: 428,
    version: "v2.18.4",
    updatedAt: "2026-09-29T08:42:00.000Z",
  },
  {
    id: "identity",
    name: "Identity",
    description: "Authentication, sessions and organization access.",
    owner: "Core Systems",
    environment: "production",
    status: "healthy",
    availability: 99.99,
    latencyMs: 86,
    version: "v4.7.1",
    updatedAt: "2026-09-29T07:18:00.000Z",
  },
  {
    id: "notifications",
    name: "Notifications",
    description: "Transactional email, push and webhook delivery.",
    owner: "Customer Systems",
    environment: "production",
    status: "healthy",
    availability: 99.97,
    latencyMs: 132,
    version: "v1.32.0",
    updatedAt: "2026-09-29T09:05:00.000Z",
  },
  {
    id: "search",
    name: "Search Indexer",
    description: "Near-real-time indexing and query fan-out.",
    owner: "Discovery",
    environment: "staging",
    status: "investigating",
    availability: 98.72,
    latencyMs: 611,
    version: "v3.1.0-rc.6",
    updatedAt: "2026-09-29T08:57:00.000Z",
  },
  {
    id: "billing-worker",
    name: "Billing Worker",
    description: "Usage aggregation and scheduled invoice generation.",
    owner: "Revenue Platform",
    environment: "staging",
    status: "healthy",
    availability: 99.94,
    latencyMs: 174,
    version: "v2.19.0-rc.2",
    updatedAt: "2026-09-29T08:21:00.000Z",
  },
];

const incidents: Incident[] = [
  {
    id: "INC-241",
    title: "Elevated checkout latency in eu-west",
    serviceId: "checkout",
    environment: "production",
    severity: "high",
    status: "monitoring",
    startedAt: "2026-09-29T08:36:00.000Z",
    assignee: "Maya Chen",
    summary: "A payment provider is responding slowly. Traffic is shifted to the secondary.",
  },
  {
    id: "INC-240",
    title: "Search reindex queue growing",
    serviceId: "search",
    environment: "staging",
    severity: "medium",
    status: "open",
    startedAt: "2026-09-29T08:11:00.000Z",
    assignee: "Unassigned",
    summary: "The canary consumer is processing events below the expected throughput.",
  },
  {
    id: "INC-239",
    title: "Delayed notification webhooks",
    serviceId: "notifications",
    environment: "production",
    severity: "low",
    status: "resolved",
    startedAt: "2026-09-29T06:24:00.000Z",
    assignee: "Noah Williams",
    summary: "A noisy tenant exhausted one delivery partition. Backlog has been drained.",
  },
];

const activity: ActivityItem[] = [
  {
    id: "evt-1",
    kind: "incident",
    title: "Checkout moved to monitoring",
    detail: "Maya Chen · INC-241",
    environment: "production",
    occurredAt: "2026-09-29T09:06:00.000Z",
  },
  {
    id: "evt-2",
    kind: "deploy",
    title: "Notifications v1.32.0 deployed",
    detail: "Noah Williams · 6 minutes",
    environment: "production",
    occurredAt: "2026-09-29T09:01:00.000Z",
  },
  {
    id: "evt-3",
    kind: "recovery",
    title: "Webhook delivery recovered",
    detail: "Automated health check · INC-239",
    environment: "production",
    occurredAt: "2026-09-29T08:49:00.000Z",
  },
  {
    id: "evt-4",
    kind: "deploy",
    title: "Search v3.1.0-rc.6 deployed",
    detail: "Ava Patel · staging",
    environment: "staging",
    occurredAt: "2026-09-29T08:04:00.000Z",
  },
];

export class OperationsRepository {
  private readonly incidents = [...incidents];
  private readonly activity = [...activity];

  listServices(environment: Environment): readonly Service[] {
    return services.filter((service) => service.environment === environment);
  }

  findService(id: string): Service | undefined {
    return services.find((service) => service.id === id);
  }

  listIncidents(environment: Environment): readonly Incident[] {
    return this.incidents.filter((incident) => incident.environment === environment);
  }

  listActivity(environment: Environment): readonly ActivityItem[] {
    return this.activity.filter((item) => item.environment === environment).slice(0, 6);
  }

  createIncident(input: CreateIncidentInput): Incident {
    const incident: Incident = {
      ...input,
      id: `INC-${241 + this.incidents.length}`,
      status: "open",
      startedAt: new Date().toISOString(),
      assignee: "Unassigned",
    };

    this.incidents.unshift(incident);
    this.activity.unshift({
      id: `evt-${Date.now()}`,
      kind: "incident",
      title: incident.title,
      detail: `Created from Relay · ${incident.id}`,
      environment: incident.environment,
      occurredAt: incident.startedAt,
    });
    return incident;
  }

  updateIncident(id: string, status: IncidentStatus): Incident | undefined {
    const index = this.incidents.findIndex((incident) => incident.id === id);
    const current = this.incidents[index];

    if (!current) return undefined;

    const updated = { ...current, status };
    this.incidents[index] = updated;
    this.activity.unshift({
      id: `evt-${Date.now()}`,
      kind: status === "resolved" ? "recovery" : "incident",
      title: `${current.id} moved to ${status}`,
      detail: "Updated from Relay",
      environment: current.environment,
      occurredAt: new Date().toISOString(),
    });
    return updated;
  }
}

/** Shared by the Strata controllers and the incident digest Server Component. */
export const operationsRepository = processSingleton(
  "relay.operations-repository",
  () => new OperationsRepository(),
);
