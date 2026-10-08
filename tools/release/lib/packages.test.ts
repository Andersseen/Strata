import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  CONTROLLER_PACKAGE_CONSUMER_PACKAGES,
  DIST_TAG,
  EXCLUDED_PACKAGES,
  REGISTRY_PACKAGES,
  assertPublishSelection,
  inspectPackedPackage,
} from "./packages.ts";
import type { PackageManifest } from "./packages.ts";

const ROOT = ["package.json", "README.md", "LICENSE"];

const classic: PackageManifest = {
  name: "@strata-sc/classic",
  version: "1.2.3",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
    "./package.json": "./package.json",
  },
};
const classicFiles = [...ROOT, "dist/index.js", "dist/index.d.ts"];

const serverComponents: PackageManifest = {
  name: "@strata-sc/server-components",
  version: "0.1.0",
  exports: {
    ".": { types: "./dist/fesm2022/index.d.ts", default: "./dist/fesm2022/index.js" },
    "./vite": { types: "./dist/vite/index.d.ts", default: "./dist/vite.js" },
    "./server-only": { types: "./dist/server-only/index.d.ts", default: "./dist/server-only.js" },
    "./package.json": "./package.json",
  },
  peerDependencies: { vite: ">=8.3.0 <9" },
};
const serverComponentsFiles = [
  ...ROOT,
  "CHANGELOG.md",
  "dist/fesm2022/index.js",
  "dist/fesm2022/index.d.ts",
  "dist/vite.js",
  "dist/vite/index.d.ts",
  "dist/server-only.js",
  "dist/server-only/index.d.ts",
];

const names = (packages: readonly { name: string }[]): string[] => packages.map((p) => p.name);

describe("inspectPackedPackage", () => {
  it("accepts the classic dist/index.js layout", () => {
    assert.deepEqual(inspectPackedPackage({ manifest: classic, files: classicFiles }), []);
  });

  it("accepts the Server Components fesm2022 layout with three exports", () => {
    assert.deepEqual(
      inspectPackedPackage({ manifest: serverComponents, files: serverComponentsFiles }),
      [],
    );
  });

  it("rejects a broken export target (types and default)", () => {
    const problems = inspectPackedPackage({
      manifest: serverComponents,
      files: serverComponentsFiles.filter(
        (f) => f !== "dist/vite.js" && f !== "dist/server-only/index.d.ts",
      ),
    });

    assert.deepEqual(problems, [
      "export target ./dist/vite.js not in tarball",
      "export target ./dist/server-only/index.d.ts not in tarball",
    ]);
  });

  it("does not require a global dist/index.js layout", () => {
    const problems = inspectPackedPackage({
      manifest: serverComponents,
      files: serverComponentsFiles,
    });

    assert.ok(!problems.some((p) => p.includes("dist/index.js")));
  });

  it("rejects a missing LICENSE or README", () => {
    const problems = inspectPackedPackage({
      manifest: classic,
      files: classicFiles.filter((f) => f !== "LICENSE" && f !== "README.md"),
    });

    assert.deepEqual(problems, ["missing README.md", "missing LICENSE"]);
  });

  it("rejects source, test and config files", () => {
    const problems = inspectPackedPackage({
      manifest: classic,
      files: [
        ...classicFiles,
        "src/index.ts",
        "dist/index.test.js",
        "tsconfig.json",
        "vite.config.ts",
      ],
    });

    assert.ok(problems.some((p) => p.includes("unexpected file src/index.ts")));
    assert.ok(problems.some((p) => p.includes("shipped: src/index.ts")));
    assert.ok(problems.some((p) => p.includes("shipped: dist/index.test.js")));
    assert.ok(problems.some((p) => p.includes("shipped: tsconfig.json")));
    assert.ok(problems.some((p) => p.includes("shipped: vite.config.ts")));
  });

  it("rejects private and unreleased (0.0.0) manifests", () => {
    assert.deepEqual(
      inspectPackedPackage({ manifest: { ...classic, version: "0.0.0" }, files: classicFiles }),
      ['version "0.0.0" is not a released semver version'],
    );
    assert.deepEqual(
      inspectPackedPackage({ manifest: { ...classic, private: true }, files: classicFiles }),
      ["package is private"],
    );
  });

  it("rejects workspace:, link:, file: and portal: ranges", () => {
    for (const range of ["workspace:*", "link:../x", "file:../x", "portal:../x"]) {
      const problems = inspectPackedPackage({
        manifest: { ...classic, peerDependencies: { dep: range } },
        files: classicFiles,
      });

      assert.equal(problems.length, 1, range);
    }
  });

  it("rejects an internal range that does not match the workspace version", () => {
    const problems = inspectPackedPackage({
      manifest: { ...classic, dependencies: { "@strata-sc/core": "0.1.0" } },
      files: classicFiles,
      workspaceVersion: (name) => (name === "@strata-sc/core" ? "0.2.1" : undefined),
    });

    assert.equal(problems.length, 1);
  });

  it("rejects dependencies on excluded packages", () => {
    const problems = inspectPackedPackage({
      manifest: { ...classic, dependencies: { "@strata-sc/h3": "1.0.0" } },
      files: classicFiles,
    });

    assert.deepEqual(problems, ["depends on excluded package @strata-sc/h3"]);
  });
});

describe("registry selection", () => {
  it("selects core, analog and server-components; excludes h3", () => {
    assert.deepEqual(names(REGISTRY_PACKAGES), [
      "@strata-sc/core",
      "@strata-sc/analog",
      "@strata-sc/server-components",
    ]);
    assert.deepEqual(EXCLUDED_PACKAGES, ["@strata-sc/h3"]);
    assert.doesNotThrow(() => assertPublishSelection(REGISTRY_PACKAGES));
  });

  it("refuses to select an excluded package", () => {
    assert.throws(
      () => assertPublishSelection([{ name: "@strata-sc/h3", dir: "packages/h3" }]),
      /excluded package/,
    );
  });

  it("selects only workspace packages, never fixtures or apps", () => {
    assert.ok(REGISTRY_PACKAGES.every(({ dir }) => /^packages\/[a-z0-9-]+$/.test(dir)));
  });

  it("keeps the controllers package consumer on core and analog only", () => {
    assert.deepEqual(names(CONTROLLER_PACKAGE_CONSUMER_PACKAGES), [
      "@strata-sc/core",
      "@strata-sc/analog",
    ]);
  });

  it("never publishes to latest", () => {
    assert.notEqual(DIST_TAG, "latest");
    assert.equal(DIST_TAG, "next");
  });
});
