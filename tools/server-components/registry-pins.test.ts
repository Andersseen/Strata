import { describe, expect, it } from "vitest";

import { inspectPackedPackage } from "../release/lib/packages.ts";

import { tuplePin } from "./lib/registry-pins.ts";

const BASELINE = {
  "@strata-sc/core": "0.2.2",
  "@strata-sc/analog": "0.13.0",
  "@strata-sc/server-components": "0.17.0",
} as const;
const RC = {
  "@strata-sc/core": "1.0.0-rc.0",
  "@strata-sc/analog": "1.0.0-rc.0",
  "@strata-sc/server-components": "1.0.0-rc.0",
} as const;

const analog = (version: string, core: string) => ({
  manifest: {
    name: "@strata-sc/analog",
    version,
    types: "./dist/index.d.ts",
    dependencies: { "@strata-sc/core": core, "@standard-schema/spec": "1.1.0" },
  },
  files: ["LICENSE", "README.md", "dist/index.d.ts", "package.json"],
});

describe("internal pins of a registry artifact", () => {
  // The upgrade/rollback A arm failed after the RC was published: analog 0.13.0's correct pin on
  // core 0.2.2 was compared with this checkout's 1.0.0-rc.0 manifests.
  it("checks each arm against its own selected tuple, whatever the checkout holds", () => {
    expect(
      inspectPackedPackage({ ...analog("0.13.0", "0.2.2"), workspaceVersion: tuplePin(BASELINE) }),
    ).toEqual([]);
    expect(
      inspectPackedPackage({
        ...analog("1.0.0-rc.0", "1.0.0-rc.0"),
        workspaceVersion: tuplePin(RC),
      }),
    ).toEqual([]);
  });

  it("still refuses an artifact pinning another core than its tuple", () => {
    expect(
      inspectPackedPackage({ ...analog("1.0.0-rc.0", "0.2.2"), workspaceVersion: tuplePin(RC) }),
    ).toEqual(["dependency @strata-sc/core@0.2.2 does not match workspace version 1.0.0-rc.0"]);
  });

  it("names no pin for a package outside the Strata tuple", () => {
    expect(tuplePin(RC)("@standard-schema/spec")).toBeUndefined();
  });
});
