import { Injectable } from "@angular/core";

import { operationsRepository } from "../../../server/strata/operations.repository";
import type { Incident, IncidentSeverity, Service } from "../../../shared/operations.models";

// Verified absent from Relay's browser output. This module reaches into
// src/server: the same in-memory store the Strata controllers mutate.
export const RELAY_INCIDENT_DIGEST_SOURCE_MARKER = "RELAY_INCIDENT_DIGEST_SERVER_SOURCE_3E77";

export interface DigestIncident {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly severity: IncidentSeverity;
  readonly status: Incident["status"];
  readonly serviceName: string;
  readonly assignee: string;
}

export interface IncidentDigest {
  readonly environment: "production";
  readonly active: readonly DigestIncident[];
  readonly resolvedCount: number;
  readonly degradedServices: readonly Pick<Service, "id" | "name" | "status">[];
  readonly provenance: string;
}

const SEVERITY_ORDER: readonly IncidentSeverity[] = ["critical", "high", "medium", "low"];

/**
 * Server-only read model over the operations repository. Injected by the
 * incident digest Server Component, so neither this module nor the repository
 * (nor its seed data) enters the browser graph.
 */
@Injectable({ providedIn: "root" })
export class IncidentDigestSource {
  private readonly repository = operationsRepository;

  read(): IncidentDigest {
    const environment = "production";
    const services = this.repository.listServices(environment);
    const incidents = this.repository.listIncidents(environment);
    const active = incidents
      .filter((incident) => incident.status !== "resolved")
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

    return {
      environment,
      active: active.map((incident) => ({
        id: incident.id,
        title: incident.title,
        summary: incident.summary,
        severity: incident.severity,
        status: incident.status,
        serviceName:
          services.find((service) => service.id === incident.serviceId)?.name ?? incident.serviceId,
        assignee: incident.assignee,
      })),
      resolvedCount: incidents.length - active.length,
      degradedServices: services
        .filter((service) => service.status !== "healthy")
        .map(({ id, name, status }) => ({ id, name, status })),
      provenance: fingerprint(`${RELAY_INCIDENT_DIGEST_SOURCE_MARKER}:${incidents.length}`),
    };
  }
}

/** A 32-bit string hash, evaluated at runtime. */
export function fingerprint(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}
