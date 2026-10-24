import "@angular/compiler";
import { Injector, createEnvironmentInjector } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import { describe, expect, it } from "vitest";

import { StrataBuildMismatchError } from "./boundary-protocol.js";
import {
  SKEW_RECOVERY_ENVIRONMENT,
  SKEW_RECOVERY_STORAGE_KEY,
  SkewRecovery,
  provideSkewRecovery,
} from "./skew-recovery.js";
import type { SkewRecoveryOptions } from "./skew-recovery.js";

class FakeBrowser {
  readonly data = new Map<string, string>();
  reloads = 0;
  clock = 1_000_000;
  blocked = false;
  rememberNothing = false;

  readonly environment = {
    storage: () => {
      if (this.blocked) throw new DOMException("denied", "SecurityError");

      return {
        getItem: (key: string) => this.data.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (!this.rememberNothing) this.data.set(key, value);
        },
      };
    },
    now: () => this.clock,
    reload: () => {
      this.reloads++;
    },
  };
}

const mismatch = () => new StrataBuildMismatchError("m", "a1", "b2");

function recovery(browser: FakeBrowser, options: SkewRecoveryOptions = {}): SkewRecovery {
  const injector = createEnvironmentInjector(
    [
      provideSkewRecovery(options),
      { provide: SKEW_RECOVERY_ENVIRONMENT, useValue: browser.environment },
      SkewRecovery,
    ],
    Injector.NULL as EnvironmentInjector,
  );

  return injector.get(SkewRecovery);
}

const run = (policy: SkewRecovery): StrataBuildMismatchError => {
  const error = mismatch();

  policy.handle(error);

  return error;
};

describe("skew recovery policy", () => {
  it("only reports by default and touches neither storage nor the document", () => {
    const browser = new FakeBrowser();
    const seen: unknown[] = [];

    expect(run(recovery(browser)).recovery).toBe("disabled");
    expect(run(recovery(browser, { onMismatch: (m) => seen.push(m) })).recovery).toBe("disabled");
    expect(run(recovery(browser, { reload: false })).recovery).toBe("disabled");
    expect(browser.reloads).toBe(0);
    expect(browser.data.size).toBe(0);
    expect(seen).toEqual([{ browserBuildId: "a1", serverBuildId: "b2" }]);
  });

  it("reloads once, records only counters, and refuses the next attempt in the window", () => {
    const browser = new FakeBrowser();
    const policy = recovery(browser, { reload: true });

    expect(run(policy).recovery).toBe("reloading");
    // A second refused host of the same document does not reload again.
    expect(run(policy).recovery).toBe("reloading");
    expect(browser.reloads).toBe(1);
    expect(browser.data.get(SKEW_RECOVERY_STORAGE_KEY)).toBe('{"count":1,"since":1000000}');
    expect([...browser.data.keys()]).toEqual([SKEW_RECOVERY_STORAGE_KEY]);

    // The "reloaded" document: a new application instance, same tab storage.
    browser.clock += 5_000;
    expect(run(recovery(browser, { reload: true })).recovery).toBe("exhausted");
    expect(browser.reloads).toBe(1);
  });

  it("allows another attempt after the window and honors a larger bound, never beyond three", () => {
    const browser = new FakeBrowser();

    expect(run(recovery(browser, { reload: true })).recovery).toBe("reloading");
    browser.clock += 301_000;
    expect(run(recovery(browser, { reload: true })).recovery).toBe("reloading");
    expect(browser.reloads).toBe(2);

    const many = new FakeBrowser();
    const outcomes = Array.from(
      { length: 6 },
      () => run(recovery(many, { reload: true, maxReloads: 99 })).recovery,
    );

    expect(outcomes).toEqual([
      "reloading",
      "reloading",
      "reloading",
      "exhausted",
      "exhausted",
      "exhausted",
    ]);
    expect(many.reloads).toBe(3);
  });

  it("does not reload when storage is blocked, forgets writes, or holds an implausible record", () => {
    const blocked = new FakeBrowser();

    blocked.blocked = true;
    expect(run(recovery(blocked, { reload: true })).recovery).toBe("storage-unavailable");
    expect(blocked.reloads).toBe(0);

    const amnesiac = new FakeBrowser();

    amnesiac.rememberNothing = true;
    expect(run(recovery(amnesiac, { reload: true })).recovery).toBe("storage-unavailable");
    expect(amnesiac.reloads).toBe(0);

    for (const junk of ["{", "null", "[]", '{"count":"1","since":1}', '{"count":-1,"since":1}']) {
      const tampered = new FakeBrowser();

      tampered.data.set(SKEW_RECOVERY_STORAGE_KEY, junk);
      expect(run(recovery(tampered, { reload: true })).recovery).toBe("exhausted");
      expect(tampered.reloads).toBe(0);
    }
  });

  it("treats a record from the future as exhausted rather than extending the window", () => {
    const browser = new FakeBrowser();

    browser.data.set(SKEW_RECOVERY_STORAGE_KEY, '{"count":1,"since":9999999999}');
    expect(run(recovery(browser, { reload: true })).recovery).toBe("reloading");
    // The stale record is replaced by a fresh window, so it cannot lock recovery forever.
    expect(browser.data.get(SKEW_RECOVERY_STORAGE_KEY)).toBe('{"count":1,"since":1000000}');
  });

  it("survives a throwing callback and a failing reload", () => {
    const browser = new FakeBrowser();
    const failing = {
      ...browser.environment,
      reload: () => {
        throw new Error("blocked");
      },
    };
    const injector = createEnvironmentInjector(
      [
        provideSkewRecovery({
          reload: true,
          onMismatch: () => {
            throw new Error("callback");
          },
        }),
        { provide: SKEW_RECOVERY_ENVIRONMENT, useValue: failing },
        SkewRecovery,
      ],
      Injector.NULL as EnvironmentInjector,
    );

    expect(run(injector.get(SkewRecovery)).recovery).toBe("exhausted");
  });
});
