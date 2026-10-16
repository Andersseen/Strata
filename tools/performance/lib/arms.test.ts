import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARMS,
  SERVER_ONLY_IMPORT,
  VARIANT_TOKEN,
  assembleArm,
  strataPackagesOf,
  usesStrata,
} from "./arms.ts";
import type { ArmSpec } from "./arms.ts";

/** A miniature fixture with the same common/variants layout as the real one. */
function miniTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), "perf-arms-test-"));
  const put = (path: string, text: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  put("common/package.json", JSON.stringify({ dependencies: { h3: "1.0.0" } }));
  put("common/src/repo.ts", `${VARIANT_TOKEN}\n\nexport const x = 1;\n`);
  put("variants/page-plain/src/page.ts", "plain");
  put("variants/page-server-component/src/page.ts", "sc");
  put("variants/api-native/src/api.ts", "native");
  put("variants/api-native-object/src/api.ts", "native-object");
  put("variants/api-controller/src/api.ts", "controller");

  return root;
}

const tarballs = {
  "@strata-sc/core": "/t/core.tgz",
  "@strata-sc/analog": "/t/analog.tgz",
  "@strata-sc/server-components": "/t/sc.tgz",
};
const assemble = (arm: ArmSpec, nativeStyle?: "response" | "object") => {
  const destination = mkdtempSync(join(tmpdir(), "perf-arm-out-"));
  const result = assembleArm({
    template: miniTemplate(),
    destination,
    arm,
    tarballs,
    ...(nativeStyle ? { nativeStyle } : {}),
  });

  return { destination, ...result };
};
const spec = (id: string): ArmSpec => ARMS.find((a) => a.id === id)!;

describe("strataPackagesOf", () => {
  it("installs a Strata package only where the arm uses it", () => {
    expect(strataPackagesOf(spec("A"))).toEqual([]);
    expect(strataPackagesOf(spec("B"))).toEqual(["@strata-sc/core", "@strata-sc/analog"]);
    expect(strataPackagesOf(spec("C"))).toEqual(["@strata-sc/server-components"]);
    expect(strataPackagesOf(spec("D"))).toEqual([
      "@strata-sc/core",
      "@strata-sc/analog",
      "@strata-sc/server-components",
    ]);
    expect(ARMS.filter(usesStrata).map((a) => a.id)).toEqual(["B", "C", "D"]);
  });
});

describe("assembleArm", () => {
  it("gives the native baseline no Strata dependency and no server-only import", () => {
    const { destination, dependencies } = assemble(spec("A"));

    expect(Object.keys(dependencies).filter((name) => name.startsWith("@strata-sc/"))).toEqual([]);
    expect(readFileSync(join(destination, "src/repo.ts"), "utf8")).not.toContain("@strata-sc");
    expect(readFileSync(join(destination, "src/page.ts"), "utf8")).toBe("plain");
    expect(readFileSync(join(destination, "src/api.ts"), "utf8")).toBe("native");
  });

  it("resolves the server-only token for Server Component arms only", () => {
    expect(readFileSync(join(assemble(spec("C")).destination, "src/repo.ts"), "utf8")).toContain(
      SERVER_ONLY_IMPORT,
    );
    expect(readFileSync(join(assemble(spec("D")).destination, "src/repo.ts"), "utf8")).toContain(
      SERVER_ONLY_IMPORT,
    );
    expect(
      readFileSync(join(assemble(spec("B")).destination, "src/repo.ts"), "utf8"),
    ).not.toContain(SERVER_ONLY_IMPORT);
  });

  it("never leaves the variant token behind", () => {
    for (const arm of ARMS)
      expect(readFileSync(join(assemble(arm).destination, "src/repo.ts"), "utf8")).not.toContain(
        VARIANT_TOKEN,
      );
  });

  it("writes tarball dependencies for exactly the arm's packages", () => {
    expect(assemble(spec("B")).dependencies).toEqual({
      h3: "1.0.0",
      "@strata-sc/core": "file:/t/core.tgz",
      "@strata-sc/analog": "file:/t/analog.tgz",
    });
  });

  it("selects the diagnostic native handler only on request and never for controller arms", () => {
    expect(
      readFileSync(join(assemble(spec("A"), "object").destination, "src/api.ts"), "utf8"),
    ).toBe("native-object");
    expect(
      readFileSync(join(assemble(spec("B"), "object").destination, "src/api.ts"), "utf8"),
    ).toBe("controller");
  });

  it("fails when a variant file would override a common file", () => {
    const template = miniTemplate();

    writeFileSync(join(template, "variants/page-plain/src/repo.ts"), "override");

    expect(() =>
      assembleArm({
        template,
        destination: mkdtempSync(join(tmpdir(), "perf-arm-out-")),
        arm: spec("A"),
        tarballs,
      }),
    ).toThrow(/overrides/);
  });

  it("fails when a needed tarball is missing", () => {
    expect(() =>
      assembleArm({
        template: miniTemplate(),
        destination: mkdtempSync(join(tmpdir(), "perf-arm-out-")),
        arm: spec("B"),
        tarballs: {},
      }),
    ).toThrow(/No tarball/);
  });

  it("fails when the fixture directory is missing", () => {
    expect(() =>
      assembleArm({
        template: join(tmpdir(), "perf-no-such-template"),
        destination: "/tmp/x",
        arm: spec("A"),
        tarballs,
      }),
    ).toThrow(/Missing fixture/);
    expect(existsSync("/tmp/x/src")).toBe(false);
  });
});
