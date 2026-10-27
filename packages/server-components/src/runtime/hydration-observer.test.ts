import "@angular/compiler";
import { Injector, createEnvironmentInjector } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import { describe, expect, it } from "vitest";

import {
  STRATA_HYDRATION_OBSERVER,
  notifyStrataHydrationObserver,
  provideStrataHydrationObserver,
} from "./hydration-observer.js";
import type { StrataHydrationObservation, StrataHydrationObserver } from "./hydration-observer.js";

const observation = (): StrataHydrationObservation => ({
  hostSelector: "strata-product-details",
  outcome: "committed",
  discoveredBoundaries: 2,
  committedBoundaries: 2,
  buildMismatch: false,
  elapsedMs: 1.25,
});

describe("Strata hydration observer provider", () => {
  it("is absent by default and scoped to the injector that configures it", () => {
    const parent = createEnvironmentInjector([], Injector.NULL as EnvironmentInjector);
    const events: StrataHydrationObservation[] = [];
    const child = createEnvironmentInjector(
      [provideStrataHydrationObserver((event) => events.push(event))],
      parent,
    );

    expect(parent.get(STRATA_HYDRATION_OBSERVER, null)).toBeNull();
    expect(child.get(STRATA_HYDRATION_OBSERVER)).toBeTypeOf("function");
    child.get(STRATA_HYDRATION_OBSERVER)(observation());
    expect(events).toEqual([observation()]);
    child.destroy();
    parent.destroy();
  });

  it("freezes a flat event and isolates synchronous observer errors and mutation", () => {
    let received: StrataHydrationObservation | undefined;
    notifyStrataHydrationObserver((event) => {
      received = event;
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.getPrototypeOf(event)).toBeNull();
      try {
        (event as { outcome: string }).outcome = "commit-failed";
      } catch {
        // ESM strict mode rejects the attempted mutation.
      }
      throw new Error("observer failure");
    }, observation());

    expect(received).toEqual(observation());
  });

  it("consumes rejected promises and custom thenables without awaiting them", async () => {
    const rejectedObserver = (() =>
      Promise.reject(new Error("private canary"))) as unknown as StrataHydrationObserver;
    notifyStrataHydrationObserver(rejectedObserver, observation());
    notifyStrataHydrationObserver(
      () =>
        ({
          then: (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) =>
            reject(new Error("thenable canary")),
        }) as never,
      observation(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("does no work without an observer", () => {
    expect(() => notifyStrataHydrationObserver(null, observation())).not.toThrow();
  });
});
