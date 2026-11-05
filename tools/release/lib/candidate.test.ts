import { describe, expect, it } from "vitest";

import {
  candidateId,
  duplicateProblems,
  installedTreeProblems,
  lockDigest,
  lockSourceProblems,
  privatePackageProblems,
  recordProblems,
  recordTuple,
  registryDriftProblems,
  resolvedSummary,
  stableJson,
  stalenessProblems,
  strataLockProblems,
  toolchainProblems,
} from "./candidate.ts";
import type { CandidateRecord, PackageLock, Toolchain } from "./candidate.ts";
import type { RegistryArtifact, TuplePackage } from "./registry-tuple.ts";

const REG = "https://registry.npmjs.org";
const integrity = (seed: string): string =>
  `sha512-${Buffer.from(seed.padEnd(64, "x")).toString("base64")}`;
const tarball = (name: string, version: string): string =>
  `${REG}/${name}/-/${name.split("/").pop()}-${version}.tgz`;

const STRATA = {
  "@strata-sc/core": "0.2.2",
  "@strata-sc/analog": "0.12.0",
  "@strata-sc/server-components": "0.14.0",
} as const satisfies Record<TuplePackage, string>;

const entry = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: tarball(name, version),
  integrity: integrity(`${name}@${version}`),
  ...extra,
});

function lock(): PackageLock {
  return {
    name: "consumer",
    lockfileVersion: 3,
    packages: {
      "": { name: "consumer", dependencies: { "@angular/core": "22.2.3" } },
      "node_modules/@angular/core": entry("@angular/core", "22.2.3"),
      "node_modules/vite": entry("vite", "8.3.0", { dev: true }),
      "node_modules/rolldown": entry("rolldown", "1.2.0", { dev: true }),
      "node_modules/@rolldown/binding-linux-x64-gnu": entry(
        "@rolldown/binding-linux-x64-gnu",
        "1.2.0",
        { optional: true, dev: true },
      ),
      ...Object.fromEntries(
        Object.entries(STRATA).map(([name, version]) => [
          `node_modules/${name}`,
          entry(name, version),
        ]),
      ),
    },
  };
}

function record(l: PackageLock = lock()): CandidateRecord {
  const strata = Object.fromEntries(
    Object.entries(STRATA).map(([name, version]) => [
      name,
      { version, tarball: tarball(name, version), integrity: integrity(`${name}@${version}`) },
    ]),
  ) as CandidateRecord["strata"];
  const trees = {
    consumer: { digest: lockDigest(l), packages: 7, lockfileVersion: 3 },
    "consumer-ts59": {
      digest: lockDigest({ lockfileVersion: 3 }),
      packages: 0,
      lockfileVersion: 3,
    },
  };

  return {
    schema: 1,
    id: candidateId(strata, trees),
    capturedAt: "2026-11-05T00:00:00.000Z",
    sourceSha: "a".repeat(40),
    fixtureSourceDigest: "b".repeat(64),
    registry: REG,
    strata,
    direct: {
      dependencies: { "@angular/core": "22.2.3", ...STRATA },
      devDependencies: { vite: "8.3.0" },
    },
    trees,
    resolved: resolvedSummary(l),
    toolchain: TOOLS,
  };
}

const TOOLS: Toolchain = {
  node: "v22.23.1",
  npm: "10.9.8",
  playwright: "1.62.1",
  chromium: "141.0.0.0",
  wrangler: "4.135.0",
  compatibilityDate: "2026-09-21",
  compatibilityFlags: [],
  platform: "darwin-arm64",
};

describe("candidate identity", () => {
  it("digests a lock independently of key order and formatting", () => {
    const a = lock();
    const reordered: PackageLock = {
      packages: Object.fromEntries(Object.entries(a.packages!).reverse()),
      lockfileVersion: 3,
      name: "renamed-root-is-not-in-the-tree",
    };

    expect(lockDigest(reordered)).toBe(lockDigest(a));
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("changes the digest when any resolved package changes", () => {
    const changed = structuredClone(lock()) as { packages: Record<string, { version?: string }> };

    changed.packages["node_modules/rolldown"]!.version = "1.2.1";
    expect(lockDigest(changed as PackageLock)).not.toBe(lockDigest(lock()));
  });

  it("accepts a well-formed record and rejects one whose id does not match its content", () => {
    expect(recordProblems(record())).toEqual([]);
    expect(recordProblems({ ...record(), id: "0000000000000000" })).toEqual([
      expect.stringMatching(/does not match its content/),
    ]);
    expect(recordProblems({ ...record(), sourceSha: "main" })).toContain("sourceSha missing");
    expect(recordTuple(record())).toEqual(STRATA);
  });

  it("summarizes the resolved framework tuple from the top of the tree", () => {
    expect(resolvedSummary(lock())).toEqual({
      "@angular/core": "22.2.3",
      vite: "8.3.0",
      rolldown: "1.2.0",
    });
  });
});

describe("frozen candidate refusals", () => {
  it("accepts the recorded lock", () => {
    const l = lock();

    expect(lockSourceProblems(l)).toEqual([]);
    expect(duplicateProblems(l)).toEqual([]);
    expect(privatePackageProblems(l)).toEqual([]);
    expect(strataLockProblems(record(l), l)).toEqual([]);
  });

  it("refuses a workspace link, a file: tarball and a missing integrity", () => {
    const l = structuredClone(lock()) as { packages: Record<string, Record<string, unknown>> };

    l.packages["node_modules/@strata-sc/core"] = { resolved: "../../packages/core", link: true };
    l.packages["node_modules/vite"]!["resolved"] = "file:../vite-8.3.0.tgz";
    delete l.packages["node_modules/rolldown"]!["integrity"];

    const problems = lockSourceProblems(l);

    expect(problems).toHaveLength(3);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@strata-sc\/core: a link/),
        expect.stringMatching(/vite: resolved from file:/),
        expect.stringMatching(/rolldown: no sha512 integrity/),
      ]),
    );
  });

  it("refuses an unexpected Strata version and a changed lock integrity", () => {
    const l = structuredClone(lock()) as { packages: Record<string, Record<string, unknown>> };

    l.packages["node_modules/@strata-sc/analog"] = entry("@strata-sc/analog", "0.12.1");
    expect(strataLockProblems(record(), l as PackageLock)).toEqual([
      "@strata-sc/analog: locked 0.12.1, candidate 0.12.0",
      expect.stringMatching(/resolved .*0\.12\.1\.tgz/),
      expect.stringMatching(/integrity/),
    ]);
  });

  it("accepts a bundled dependency without its own source, and Vite copies off the build path", () => {
    const l = structuredClone(lock()) as { packages: Record<string, Record<string, unknown>> };

    l.packages["node_modules/@parcel/watcher-wasm/node_modules/napi-wasm"] = {
      version: "1.1.0",
      inBundle: true,
    };
    l.packages["node_modules/vitest/node_modules/vite"] = entry("vite", "7.3.7");
    l.packages["node_modules/@angular/build/node_modules/vite"] = entry("vite", "8.1.5");
    expect(lockSourceProblems(l as PackageLock)).toEqual([]);
    expect(duplicateProblems(l as PackageLock)).toEqual([]);

    l.packages["node_modules/@analogjs/platform/node_modules/vite"] = entry("vite", "8.1.5");
    expect(duplicateProblems(l as PackageLock)).toEqual([
      "vite: a second copy on the build path (node_modules/@analogjs/platform/node_modules/vite)",
    ]);
  });

  it("refuses a duplicate framework instance and the private H3 package", () => {
    const l = structuredClone(lock()) as { packages: Record<string, Record<string, unknown>> };

    l.packages["node_modules/@analogjs/platform/node_modules/@angular/core"] = entry(
      "@angular/core",
      "22.1.0",
    );
    l.packages["node_modules/@strata-sc/h3"] = entry("@strata-sc/h3", "0.1.0");
    expect(duplicateProblems(l as PackageLock)).toEqual([
      expect.stringMatching(/^@angular\/core: 2 copies/),
    ]);
    expect(privatePackageProblems(l as PackageLock)).toHaveLength(1);
  });

  it("refuses a registry whose integrity or tarball changed for the same version", () => {
    const artifacts = Object.fromEntries(
      Object.entries(record().strata).map(([name, s]) => [
        name,
        { name, version: s.version, tarball: s.tarball, integrity: s.integrity, dependencies: {} },
      ]),
    ) as Record<TuplePackage, RegistryArtifact>;

    expect(registryDriftProblems(record(), artifacts)).toEqual([]);
    artifacts["@strata-sc/core"] = {
      ...artifacts["@strata-sc/core"],
      integrity: integrity("republished"),
    };
    expect(registryDriftProblems(record(), artifacts)).toEqual([
      expect.stringMatching(/@strata-sc\/core@0\.2\.2: registry integrity changed/),
    ]);
  });

  it("refuses a candidate the fixture manifest no longer matches", () => {
    const template = {
      dependencies: {
        "@angular/core": "22.2.3",
        "@strata-sc/core": "REPLACED_BY_RUNNER",
        "@strata-sc/analog": "REPLACED_BY_RUNNER",
        "@strata-sc/server-components": "REPLACED_BY_RUNNER",
      },
      devDependencies: { vite: "8.3.0" },
    };

    expect(stalenessProblems(record(), template)).toEqual([]);
    expect(
      stalenessProblems(record(), {
        ...template,
        devDependencies: { vite: "8.4.0", wrangler: "4.135.0" },
      }),
    ).toEqual([
      "devDependencies.vite: fixture declares 8.4.0, candidate 8.3.0",
      "devDependencies.wrangler: fixture declares 4.135.0, candidate (nothing)",
    ]);
  });

  it("compares every installed package with its lock entry; only optional ones may be absent", () => {
    const l = lock();
    const installed = new Map(
      Object.entries(l.packages!)
        .filter(([key, e]) => key !== "" && !e.optional)
        .map(([key, e]) => [key, e.version!]),
    );

    expect(installedTreeProblems(l, (key) => installed.get(key))).toEqual({
      problems: [],
      checked: 6,
      skippedOptional: 1,
    });

    installed.set("node_modules/vite", "8.3.1");
    installed.delete("node_modules/@angular/core");
    expect(installedTreeProblems(l, (key) => installed.get(key)).problems).toEqual([
      "node_modules/@angular/core: locked 22.2.3 but not installed",
      "node_modules/vite: installed 8.3.1, locked 8.3.0",
    ]);
  });

  it("refuses a different Node major, Playwright, wrangler or compatibility setting", () => {
    expect(toolchainProblems(TOOLS, { ...TOOLS, node: "v22.30.0", chromium: "x" })).toEqual([]);
    expect(
      toolchainProblems(TOOLS, {
        ...TOOLS,
        node: "v24.1.0",
        playwright: "1.63.0",
        compatibilityFlags: ["nodejs_compat"],
      }),
    ).toEqual([
      "Node major 24 differs from the candidate's 22",
      "playwright 1.63.0 differs from the candidate's 1.62.1",
      "compatibility flags [nodejs_compat] differ from the candidate's []",
    ]);
  });
});
