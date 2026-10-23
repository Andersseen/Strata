import { describe, expect, it } from "vitest";

import { checkBuildIdentity, compiledBuildId, isValidBuildId } from "./build-identity.js";

describe("build identity", () => {
  it("accepts short public labels and nothing else", () => {
    for (const ok of ["a", "2026.10.1", "rel_1:abc+meta-2", "A".repeat(64)]) {
      expect(isValidBuildId(ok)).toBe(true);
    }
    for (const bad of ["", "-a", ".a", "a b", 'a"b', "a<b", "é", "A".repeat(65), "a\nb"]) {
      expect(isValidBuildId(bad)).toBe(false);
    }
    expect(isValidBuildId(undefined)).toBe(false);
    expect(isValidBuildId(7)).toBe(false);
  });

  it("is not enabled when no constant was compiled in", () => {
    expect(compiledBuildId()).toBeUndefined();
  });

  it("enforces nothing when the browser has no identity, whatever the host says", () => {
    for (const attribute of [null, "x", "not valid!"]) {
      expect(checkBuildIdentity(undefined, attribute)).toEqual({ kind: "compatible" });
    }
  });

  it("classifies the host attribute against the browser identity", () => {
    expect(checkBuildIdentity("a1", "a1")).toEqual({ kind: "compatible" });
    expect(checkBuildIdentity("a1", "b2")).toEqual({
      kind: "mismatch",
      browser: "a1",
      server: "b2",
    });
    expect(checkBuildIdentity("a1", null)).toEqual({ kind: "missing" });
    // Garbage is never evidence of a deployment.
    expect(checkBuildIdentity("a1", "")).toEqual({ kind: "malformed" });
    expect(checkBuildIdentity("a1", "<script>")).toEqual({ kind: "malformed" });
    expect(checkBuildIdentity("a1", "x".repeat(65))).toEqual({ kind: "malformed" });
  });
});
