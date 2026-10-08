import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { publishedVersion } from "./published.ts";

const NAME = "@strata-sc/server-components";

describe("publishedVersion", () => {
  it("returns the exact version of the package among the published ones", () => {
    const json = JSON.stringify([
      { name: "@strata-sc/core", version: "0.2.2" },
      { name: NAME, version: "0.1.0" },
    ]);

    assert.equal(publishedVersion(json, NAME), "0.1.0");
  });

  it("returns undefined when the package was not published", () => {
    assert.equal(
      publishedVersion('[{"name":"@strata-sc/core","version":"0.2.2"}]', NAME),
      undefined,
    );
    assert.equal(publishedVersion("[]", NAME), undefined);
    assert.equal(publishedVersion("", NAME), undefined);
    assert.equal(publishedVersion(undefined, NAME), undefined);
  });

  it("rejects malformed output and non-exact versions", () => {
    assert.throws(() => publishedVersion("{}", NAME), /not a JSON array/);
    assert.throws(
      () => publishedVersion(`[{"name":"${NAME}","version":"next"}]`, NAME),
      /exact semver/,
    );
    assert.throws(
      () => publishedVersion(`[{"name":"${NAME}","version":"^0.1.0"}]`, NAME),
      /exact semver/,
    );
  });
});
