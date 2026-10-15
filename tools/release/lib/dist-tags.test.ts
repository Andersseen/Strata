import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { compareVersions, distTagFor, planDistTags } from "./dist-tags.ts";

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
