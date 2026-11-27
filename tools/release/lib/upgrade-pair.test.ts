import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUILD_IDS,
  DEFAULT_PAIR,
  isValidBuildId,
  pairEnvName,
  selectedBuildIds,
  selectedPair,
} from "../../server-components/lib/upgrade-rollback.ts";

describe("upgrade/rollback release pair selection", () => {
  it("defaults to the upgrade from the last published 0.x tuple to the RC0 tuple", () => {
    const pair = selectedPair({});

    expect(pair).toEqual(DEFAULT_PAIR);
    expect(pair.a).toEqual({
      "@strata-sc/core": "0.2.2",
      "@strata-sc/analog": "0.13.0",
      "@strata-sc/server-components": "0.17.0",
    });
    for (const version of Object.values(pair.b)) expect(version).toBe("1.0.0-rc.0");
  });

  it("still reproduces the historical server-components pair through explicit inputs", () => {
    const pair = selectedPair({
      STRATA_UPGRADE_A_SERVER_COMPONENTS_VERSION: "0.16.0",
      STRATA_UPGRADE_B_CORE_VERSION: "0.2.2",
      STRATA_UPGRADE_B_ANALOG_VERSION: "0.13.0",
      STRATA_UPGRADE_B_SERVER_COMPONENTS_VERSION: "0.17.0",
    });

    expect(pair.a).toEqual({
      "@strata-sc/core": "0.2.2",
      "@strata-sc/analog": "0.13.0",
      "@strata-sc/server-components": "0.16.0",
    });
    expect(pair.b).toEqual({
      "@strata-sc/core": "0.2.2",
      "@strata-sc/analog": "0.13.0",
      "@strata-sc/server-components": "0.17.0",
    });
  });

  it("labels deployments independently of the RC versions in the pair", () => {
    const ids = selectedBuildIds({});

    for (const side of ["a", "b"] as const) {
      for (const version of Object.values(DEFAULT_PAIR[side])) {
        expect(ids[side]).not.toContain(version);
      }
    }
  });

  it("takes each side's exact versions from its own environment variables", () => {
    const pair = selectedPair({
      STRATA_UPGRADE_B_SERVER_COMPONENTS_VERSION: "0.14.0-rc.1",
      STRATA_UPGRADE_A_ANALOG_VERSION: "0.11.0",
    });

    expect(pair.b["@strata-sc/server-components"]).toBe("0.14.0-rc.1");
    expect(pair.a["@strata-sc/analog"]).toBe("0.11.0");
    expect(pair.a["@strata-sc/server-components"]).toBe(
      DEFAULT_PAIR.a["@strata-sc/server-components"],
    );
    expect(pairEnvName("b", "@strata-sc/server-components")).toBe(
      "STRATA_UPGRADE_B_SERVER_COMPONENTS_VERSION",
    );
  });

  it("refuses a dist-tag or a range, naming the package", () => {
    expect(() => selectedPair({ STRATA_UPGRADE_A_CORE_VERSION: "latest" })).toThrow(
      /@strata-sc\/core/,
    );
    expect(() => selectedPair({ STRATA_UPGRADE_B_ANALOG_VERSION: "^0.12.0" })).toThrow(
      /@strata-sc\/analog/,
    );
  });

  it("gives the two releases distinct valid build ids that are not package versions", () => {
    const ids = selectedBuildIds({});

    expect(ids.a).not.toBe(ids.b);
    expect(isValidBuildId(ids.a) && isValidBuildId(ids.b)).toBe(true);
    expect(ids).toEqual(DEFAULT_BUILD_IDS);
    expect(selectedBuildIds({ STRATA_UPGRADE_A_BUILD_ID: "x" }).a).toBe("x");
  });

  it("applies the runtime's own build id pattern", () => {
    expect(isValidBuildId("rel-2026.10.1")).toBe(true);
    expect(isValidBuildId("")).toBe(false);
    expect(isValidBuildId('a"b')).toBe(false);
    expect(isValidBuildId("<img>")).toBe(false);
    expect(isValidBuildId("a".repeat(65))).toBe(false);
  });
});
