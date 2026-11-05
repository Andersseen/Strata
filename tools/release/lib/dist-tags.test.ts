import assert from "node:assert/strict";

import { describe, expect, it } from "vitest";

import {
  awaitCompliantDistTags,
  compareVersions,
  distTagFor,
  planDistTags,
  awaitVersionVisible,
} from "./dist-tags.ts";

describe("compareVersions", () => {
  it("orders by semver precedence", () => {
    const ordered = [
      "0.0.0-stage",
      "0.1.0",
      "0.2.0",
      "0.2.1",
      "0.10.0",
      "1.0.0-rc.1",
      "1.0.0-rc.2",
      "1.0.0-rc.10",
      "1.0.0",
    ];

    for (let i = 1; i < ordered.length; i++) {
      assert.ok(
        compareVersions(ordered[i - 1]!, ordered[i]!) < 0,
        `${ordered[i - 1]} < ${ordered[i]}`,
      );
      assert.ok(
        compareVersions(ordered[i]!, ordered[i - 1]!) > 0,
        `${ordered[i]} > ${ordered[i - 1]}`,
      );
    }
    assert.equal(compareVersions("0.2.1", "0.2.1"), 0);
  });

  it("rejects non-exact versions", () => {
    assert.throws(() => compareVersions("next", "0.1.0"), /not an exact semver/);
  });
});

describe("distTagFor", () => {
  it("releases stable versions on latest and prereleases on next", () => {
    assert.equal(distTagFor("0.2.1"), "latest");
    assert.equal(distTagFor("1.0.0"), "latest");
    assert.equal(distTagFor("1.0.0-rc.1"), "next");
  });
});

describe("planDistTags", () => {
  it("promotes a stable version stuck behind latest, and keeps next level with it", () => {
    assert.deepEqual(planDistTags({ latest: "0.1.0", next: "0.2.1" }, "0.2.1"), [
      { tag: "latest", from: "0.1.0", to: "0.2.1" },
    ]);
    assert.deepEqual(planDistTags({ latest: "0.2.1", next: "0.2.1" }, "0.3.0"), [
      { tag: "latest", from: "0.2.1", to: "0.3.0" },
      { tag: "next", from: "0.2.1", to: "0.3.0" },
    ]);
  });

  it("is a no-op when the tags already comply", () => {
    assert.deepEqual(planDistTags({ latest: "0.2.1", next: "0.2.1" }, "0.2.1"), []);
    assert.deepEqual(planDistTags({ latest: "0.2.1" }, "0.2.1"), []);
  });

  it("does not create next for a stable release", () => {
    assert.deepEqual(planDistTags({}, "0.1.0"), [{ tag: "latest", from: undefined, to: "0.1.0" }]);
  });

  it("releases a prerelease on next only, leaving latest alone", () => {
    assert.deepEqual(planDistTags({ latest: "0.9.0", next: "0.9.0" }, "1.0.0-rc.1"), [
      { tag: "next", from: "0.9.0", to: "1.0.0-rc.1" },
    ]);
  });

  it("never moves a tag backwards", () => {
    assert.deepEqual(planDistTags({ latest: "0.3.0", next: "1.0.0-rc.1" }, "0.2.1"), []);
    assert.deepEqual(planDistTags({ latest: "0.9.0", next: "1.0.0-rc.2" }, "1.0.0-rc.1"), []);
  });
});

describe("awaitCompliantDistTags", () => {
  const record =
    (waits: number[]) =>
    (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };
  const options = { attempts: 4, firstDelayMs: 10, maxDelayMs: 25 };
  const reads = (...sequence: Record<string, string>[]) => {
    let index = 0;
    return () => sequence[Math.min(index++, sequence.length - 1)]!;
  };

  it("returns on the first read when the update is already visible", async () => {
    const waits: number[] = [];
    const result = await awaitCompliantDistTags(
      reads({ latest: "0.14.0", next: "0.14.0" }),
      "0.14.0",
      record(waits),
      options,
    );

    assert.equal(result.attempts, 1);
    assert.deepEqual(waits, []);
  });

  it("waits out a stale read after a successful update (hosted runs 41526028881, 41615685717)", async () => {
    const waits: number[] = [];
    const result = await awaitCompliantDistTags(
      reads(
        { latest: "0.14.0", next: "0.2.0" },
        { latest: "0.14.0", next: "0.2.0" },
        { latest: "0.14.0", next: "0.14.0" },
      ),
      "0.14.0",
      record(waits),
      options,
    );

    assert.equal(result.attempts, 3);
    assert.deepEqual(result.tags, { latest: "0.14.0", next: "0.14.0" });
    assert.deepEqual(waits, [10, 20]);
  });

  it("still fails closed, with the last tags, when the registry never complies", async () => {
    const waits: number[] = [];

    await assert.rejects(
      awaitCompliantDistTags(
        reads({ latest: "0.14.0", next: "0.2.0" }),
        "0.14.0",
        record(waits),
        options,
      ),
      /still out of policy after the update \(4 reads\): \{"latest":"0.14.0","next":"0.2.0"\}/,
    );
    assert.deepEqual(waits, [10, 20, 25]);
  });
});

describe("awaitVersionVisible (Release run 42034642481)", () => {
  const options = { attempts: 4, firstDelayMs: 10, maxDelayMs: 40 };

  it("waits out a just-published version that npm does not show yet", async () => {
    const waits: number[] = [];
    const reads = [false, false, true];
    const attempts = await awaitVersionVisible(
      () => reads.shift() ?? true,
      (ms) => {
        waits.push(ms);

        return Promise.resolve();
      },
      options,
    );

    expect(attempts).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it("fails closed when the version never appears, after exactly the bound", async () => {
    let reads = 0;

    await expect(
      awaitVersionVisible(
        () => {
          reads++;

          return false;
        },
        () => Promise.resolve(),
        options,
      ),
    ).rejects.toThrow(/still not visible on npm after 4 reads/);
    expect(reads).toBe(4);
  });
});
