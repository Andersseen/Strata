import { describe, expect, it } from "vitest";

import { operationsRepository } from "../../../server/strata/operations.repository";

import { IncidentDigestSource } from "./incident-digest.source";

describe("IncidentDigestSource", () => {
  it("summarizes active production incidents, most severe first", () => {
    const digest = new IncidentDigestSource().read();

    expect(digest.environment).toBe("production");
    expect(digest.active.every((incident) => incident.status !== "resolved")).toBe(true);
    expect(digest.active.map((incident) => incident.id)).toContain("INC-241");
    expect(digest.active.find((incident) => incident.id === "INC-241")?.serviceName).toBe(
      "Checkout API",
    );
    expect(digest.resolvedCount).toBeGreaterThanOrEqual(1);
    expect(digest.degradedServices).toContainEqual({
      id: "checkout",
      name: "Checkout API",
      status: "degraded",
    });
    expect(digest.provenance).toMatch(/^[0-9a-f]+$/);
  });

  it("reads what the controllers' repository wrote, on every call", () => {
    const source = new IncidentDigestSource();
    const created = operationsRepository.createIncident({
      title: "Card declines spike",
      serviceId: "checkout",
      environment: "production",
      severity: "critical",
      summary: "Issuer responses degraded.",
    });

    const afterCreate = source.read();
    expect(afterCreate.active[0]).toMatchObject({
      id: created.id,
      severity: "critical",
      status: "open",
      serviceName: "Checkout API",
      assignee: "Unassigned",
    });

    operationsRepository.updateIncident(created.id, "resolved");

    const afterResolve = source.read();
    expect(afterResolve.active.map((incident) => incident.id)).not.toContain(created.id);
    expect(afterResolve.resolvedCount).toBe(afterCreate.resolvedCount + 1);
  });

  it("never returns staging incidents", () => {
    expect(new IncidentDigestSource().read().active.map((incident) => incident.id)).not.toContain(
      "INC-240",
    );
  });
});
