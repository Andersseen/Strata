import { afterEach, describe, expect, it, vi } from "vitest";

import { processSingleton } from "./process-singleton";

const KEY = "relay.test.process-singleton";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for(KEY)];
});

describe("processSingleton", () => {
  it("creates once and returns the same instance for the same key", () => {
    const create = vi.fn(() => ({ id: Math.random() }));

    expect(processSingleton(KEY, create)).toBe(processSingleton(KEY, create));
    expect(create).toHaveBeenCalledOnce();
  });

  it("shares the operations repository across two evaluations of its module", async () => {
    // Two evaluations stand in for the Angular SSR bundle and Nitro's bundle,
    // which each carry their own copy of the repository module.
    vi.resetModules();
    const first = await import("./operations.repository");
    vi.resetModules();
    const second = await import("./operations.repository");

    expect(first).not.toBe(second);
    expect(second.operationsRepository).toBe(first.operationsRepository);

    const created = first.operationsRepository.createIncident({
      title: "Written by a controller",
      serviceId: "checkout",
      environment: "production",
      severity: "high",
      summary: "Read by a Server Component.",
    });

    expect(second.operationsRepository.listIncidents("production")[0]?.id).toBe(created.id);
  });
});
