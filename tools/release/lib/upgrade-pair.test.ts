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
  it("defaults to the two latest published server-components minors on one core and analog", () => {
    const pair = selectedPair({});

    expect(pair).toEqual(DEFAULT_PAIR);
    expect(pair.a["@strata-sc/core"]).toBe(pair.b["@strata-sc/core"]);
    expect(pair.a["@strata-sc/server-components"]).not.toBe(pair.b["@strata-sc/server-components"]);
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
