import { describe, expect, it } from "vitest";

import { STRATA_VERSION } from "./index.js";

describe("@strata/core", () => {
  it("exposes the current package version", () => {
    expect(STRATA_VERSION).toBe("0.0.0");
  });
});
