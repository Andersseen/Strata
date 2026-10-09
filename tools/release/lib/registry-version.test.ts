import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { latestTagVerdict, resolveRegistryVersion } from "./registry-version.ts";

describe("resolveRegistryVersion", () => {
  it("uses an explicit exact version", () => {
    assert.equal(resolveRegistryVersion("0.1.1", "0.1.0"), "0.1.1");
    assert.equal(resolveRegistryVersion(" 0.2.0-beta.1 ", "0.1.0"), "0.2.0-beta.1");
  });

  it("falls back to the manifest version when the input is empty", () => {
    assert.equal(resolveRegistryVersion("", "0.1.0"), "0.1.0");
    assert.equal(resolveRegistryVersion(undefined, "0.1.0"), "0.1.0");
    assert.equal(resolveRegistryVersion("  ", "0.1.0"), "0.1.0");
  });

  it("rejects dist-tags and ranges", () => {
    for (const bad of ["next", "latest", "^0.1.0", "~0.1.0", "*", "0.1", ">=0.1.0", "v0.1.0"]) {
      assert.throws(() => resolveRegistryVersion(bad, "0.1.0"), /not an exact semver/, bad);
    }
  });
});

describe("latestTagVerdict", () => {
  it("accepts latest on another version, or absent", () => {
    assert.equal(
      latestTagVerdict({ latest: "0.1.0", next: "0.1.1" }, ["0.1.0", "0.1.1"], "0.1.1").ok,
      true,
    );
    assert.equal(latestTagVerdict({ next: "0.1.0" }, ["0.1.0"], "0.1.0").ok, true);
  });

  it("accepts latest on the first real release, beside a 0.0.0 placeholder", () => {
    assert.equal(
      latestTagVerdict({ latest: "0.1.0", next: "0.1.0" }, ["0.0.0-stage", "0.1.0"], "0.1.0").ok,
      true,
    );
  });

  it("accepts latest on the first-ever version", () => {
    assert.equal(latestTagVerdict({ latest: "0.1.0", next: "0.1.0" }, ["0.1.0"], "0.1.0").ok, true);
  });

  it("rejects latest moved onto a version when earlier versions exist", () => {
    assert.equal(
      latestTagVerdict({ latest: "0.1.1", next: "0.1.1" }, ["0.1.0", "0.1.1"], "0.1.1").ok,
      false,
    );
  });
});
