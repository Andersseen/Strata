import { describe, expect, it } from "vitest";

import { OperationsRepository } from "./operations.repository";

describe("OperationsRepository", () => {
  it("keeps environment data isolated", () => {
    const repository = new OperationsRepository();

    expect(repository.listServices("production")).toHaveLength(3);
    expect(repository.listServices("staging")).toHaveLength(2);
    expect(
      repository
        .listServices("production")
        .every((service) => service.environment === "production"),
    ).toBe(true);
  });

  it("creates and transitions an incident", () => {
    const repository = new OperationsRepository();
    const created = repository.createIncident({
      title: "API error rate",
      serviceId: "checkout",
      environment: "production",
      severity: "critical",
      summary: "Synthetic probe is failing.",
    });

    expect(created.status).toBe("open");
    expect(repository.updateIncident(created.id, "monitoring")?.status).toBe("monitoring");
    expect(repository.listIncidents("production")[0]?.id).toBe(created.id);
  });
});
