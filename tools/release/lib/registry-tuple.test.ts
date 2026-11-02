import { describe, expect, it } from "vitest";

import {
  lockProblems,
  parseRegistryView,
  resolveTuple,
  substitutionProblems,
  tupleFromEnv,
  tupleProblems,
} from "./registry-tuple.ts";
import type { RegistryArtifact, VersionTuple } from "./registry-tuple.ts";

const manifest: VersionTuple = {
  "@strata-sc/core": "0.2.2",
  "@strata-sc/analog": "0.12.0",
  "@strata-sc/server-components": "0.13.0",
};

const artifact = (name: string, version: string, dependencies = {}): RegistryArtifact => ({
  name,
  version,
  tarball: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`,
  integrity: `sha512-${Buffer.from(`${name}@${version}`).toString("base64")}`,
  dependencies,
});

const artifacts = () => ({
  "@strata-sc/core": artifact("@strata-sc/core", "0.2.2"),
  "@strata-sc/analog": artifact("@strata-sc/analog", "0.12.0", { "@strata-sc/core": "0.2.2" }),
  "@strata-sc/server-components": artifact("@strata-sc/server-components", "0.13.0"),
});

const lockFor = (a: ReturnType<typeof artifacts>) => ({
  packages: Object.fromEntries(
    Object.values(a).map((x) => [
      `node_modules/${x.name}`,
      { version: x.version, resolved: x.tarball, integrity: x.integrity },
    ]),
  ),
});

describe("resolveTuple", () => {
  it("defaults to the manifest versions", () => {
    expect(resolveTuple({}, manifest)).toEqual(manifest);
  });

  it("lets an explicit exact version qualify a previously published release", () => {
    expect(resolveTuple({ "@strata-sc/analog": "0.11.0" }, manifest)["@strata-sc/analog"]).toBe(
      "0.11.0",
    );
  });

  it.each(["latest", "next", "^0.12.0", "*", "0.12"])("refuses %s and names the package", (v) => {
    expect(() => resolveTuple({ "@strata-sc/core": v }, manifest)).toThrow(/@strata-sc\/core/);
  });

  it("reads the tuple from the environment", () => {
    const tuple = tupleFromEnv({ STRATA_REGISTRY_CORE_VERSION: "0.2.1" }, manifest);

    expect(tuple["@strata-sc/core"]).toBe("0.2.1");
    expect(tuple["@strata-sc/analog"]).toBe("0.12.0");
  });
});

describe("parseRegistryView", () => {
  it("reads dotted and nested npm view output", () => {
    const a = artifact("@strata-sc/core", "0.2.2");

    expect(
      parseRegistryView(
        JSON.stringify({
          name: a.name,
          version: a.version,
          "dist.tarball": a.tarball,
          "dist.integrity": a.integrity,
        }),
      ),
    ).toMatchObject({ tarball: a.tarball });
    expect(
      parseRegistryView(
        JSON.stringify({
          name: a.name,
          version: a.version,
          dist: { tarball: a.tarball, integrity: a.integrity },
        }),
      )?.integrity,
    ).toBe(a.integrity);
  });

  it("returns nothing for a missing version or garbage", () => {
    expect(parseRegistryView("")).toBeUndefined();
    expect(parseRegistryView('{"error":{"code":"E404"}}')).toBeUndefined();
  });
});

describe("tupleProblems (negative controls)", () => {
  it("accepts a coherent tuple", () => {
    expect(tupleProblems(manifest, artifacts())).toEqual([]);
  });

  it("rejects an analog that pins a different core", () => {
    const a = artifacts();

    a["@strata-sc/analog"] = artifact("@strata-sc/analog", "0.12.0", {
      "@strata-sc/core": "0.2.1",
    });
    expect(tupleProblems(manifest, a).join()).toMatch(/pins @strata-sc\/core 0\.2\.1/);
  });

  it("rejects a registry answer for another version", () => {
    const a = artifacts();

    a["@strata-sc/server-components"] = artifact("@strata-sc/server-components", "0.12.0");
    expect(tupleProblems(manifest, a).join()).toMatch(/answered/);
  });
});

describe("lockProblems (negative controls)", () => {
  it("accepts the registry's own lock", () => {
    const a = artifacts();

    expect(lockProblems(manifest, a, lockFor(a))).toEqual([]);
  });

  it("detects a corrupted integrity", () => {
    const a = artifacts();
    const lock = lockFor(a);

    lock.packages["node_modules/@strata-sc/core"]!.integrity = "sha512-AAAA";
    expect(lockProblems(manifest, a, lock).join()).toMatch(/integrity differs/);
  });

  it("detects a local file: resolution in place of the registry tarball", () => {
    const a = artifacts();
    const lock = lockFor(a);

    lock.packages["node_modules/@strata-sc/analog"]!.resolved = "file:../tarballs/analog.tgz";
    expect(lockProblems(manifest, a, lock).join()).toMatch(/resolved file:/);
  });

  it("detects a nested duplicate copy and an unexpected Strata package", () => {
    const a = artifacts();
    const lock = lockFor(a);

    (lock.packages as Record<string, object>)[
      "node_modules/@strata-sc/analog/node_modules/@strata-sc/core"
    ] = { version: "0.2.1" };
    (lock.packages as Record<string, object>)["node_modules/@strata-sc/h3"] = { version: "0.1.0" };

    const problems = lockProblems(manifest, a, lock).join();

    expect(problems).toMatch(/nested copy/);
    expect(problems).toMatch(/unexpected Strata package/);
  });

  it("detects a missing entry and a wrong locked version", () => {
    const a = artifacts();
    const lock = lockFor(a);

    delete (lock.packages as Record<string, object>)["node_modules/@strata-sc/core"];
    lock.packages["node_modules/@strata-sc/analog"]!.version = "0.11.0";

    const problems = lockProblems(manifest, a, lock).join();

    expect(problems).toMatch(/no lock entry/);
    expect(problems).toMatch(/locked 0\.11\.0/);
  });
});

describe("substitutionProblems", () => {
  it("accepts exact versions and refuses file:, ranges and tags", () => {
    expect(substitutionProblems(manifest)).toEqual([]);
    expect(
      substitutionProblems({ ...manifest, "@strata-sc/core": "file:../core.tgz" }),
    ).toHaveLength(1);
    expect(substitutionProblems({ ...manifest, "@strata-sc/analog": "^0.12.0" })).toHaveLength(1);
    expect(
      substitutionProblems({ ...manifest, "@strata-sc/server-components": "latest" }),
    ).toHaveLength(1);
  });
});
