import { readFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../../consumer/lib/exec.ts";
import { packedTarballName } from "../../consumer/lib/fs-helpers.ts";

export interface PublishablePackage {
  readonly name: string;
  readonly dir: string;
}

/**
 * The only packages the registry release may publish, in publish order
 * (dependencies first). `@strata/h3` is deliberately absent: its consumer
 * type closure is blocked by H3 v2/crossws declarations (SPEC-002), so it
 * stays out of the registry until that blocker is resolved or accepted.
 */
export const PUBLISHABLE_PACKAGES: readonly PublishablePackage[] = [
  { name: "@strata/core", dir: "packages/core" },
  { name: "@strata/analog", dir: "packages/analog" },
];

export const EXCLUDED_PACKAGES: readonly string[] = ["@strata/h3"];

/** Experimental releases never move `latest`. */
export const DIST_TAG: string = "next";

export interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  types?: string;
  exports?: Record<string, string | Record<string, string>>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface TarballInspection {
  readonly path: string;
  readonly manifest: PackageManifest;
  readonly files: readonly string[];
  readonly sizeBytes: number;
  readonly problems: readonly string[];
}

export function readManifest(packageDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as PackageManifest;
}

/** Throws if the publish selection ever includes an excluded package. */
export function assertPublishSelection(packages: readonly PublishablePackage[]): void {
  const leaked = packages.filter(({ name }) => EXCLUDED_PACKAGES.includes(name));

  if (leaked.length > 0) {
    throw new Error(
      `Publish selection includes excluded package(s): ${leaked.map(({ name }) => name).join(", ")}.`,
    );
  }

  if (DIST_TAG === "latest") {
    throw new Error("Experimental releases must not publish to the `latest` dist-tag.");
  }
}

/** Packs a workspace package with pnpm (which rewrites `workspace:` ranges). */
export function packPackage(
  repoRoot: string,
  pkg: PublishablePackage,
  destination: string,
): string {
  const packageDir = join(repoRoot, pkg.dir);
  const result = run("pnpm", ["pack", "--pack-destination", destination], { cwd: packageDir });

  if (result.status !== 0) {
    throw new Error(`pnpm pack failed for ${pkg.name}:\n${result.stdout}${result.stderr}`);
  }

  return join(destination, packedTarballName(packageDir));
}

/**
 * Reads a packed tarball's real `package.json` and file list and reports
 * everything that would make it unfit for an external install.
 */
export function inspectTarball(repoRoot: string, tarballPath: string): TarballInspection {
  const files = run("tar", ["-tzf", tarballPath])
    .stdout.trim()
    .split("\n")
    .filter((entry) => entry && !entry.endsWith("/"))
    .map((entry) => entry.replace(/^package\//, ""))
    .sort();
  const manifest = JSON.parse(
    run("tar", ["-xOzf", tarballPath, "package/package.json"]).stdout,
  ) as PackageManifest;
  const sizeBytes = readFileSync(tarballPath).byteLength;
  const problems: string[] = [];

  if (manifest.private) problems.push("package is private");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version === "0.0.0") {
    problems.push(`version "${manifest.version}" is not a released semver version`);
  }

  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    if (!files.includes(required)) problems.push(`missing ${required}`);
  }

  for (const file of files) {
    if (
      !file.startsWith("dist/") &&
      !["package.json", "README.md", "LICENSE", "CHANGELOG.md"].includes(file)
    ) {
      problems.push(`unexpected file ${file}`);
    }
    if (/\.test\.|\/src\//.test(file)) problems.push(`source or test file shipped: ${file}`);
  }

  for (const target of exportTargets(manifest)) {
    if (!files.includes(target.replace(/^\.\//, "")))
      problems.push(`export target ${target} not in tarball`);
  }

  const dependencyFields = [
    manifest.dependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ];

  for (const dependencies of dependencyFields) {
    for (const [name, range] of Object.entries(dependencies ?? {})) {
      if (/^(workspace|link|file|portal):/.test(range)) {
        problems.push(`dependency ${name}@${range} is not installable from a registry`);
      }

      const workspacePackage = PUBLISHABLE_PACKAGES.find((pkg) => pkg.name === name);
      if (workspacePackage) {
        const expected = readManifest(join(repoRoot, workspacePackage.dir)).version;
        if (range !== expected) {
          problems.push(`dependency ${name}@${range} does not match workspace version ${expected}`);
        }
      }

      if (EXCLUDED_PACKAGES.includes(name)) problems.push(`depends on excluded package ${name}`);
    }
  }

  return { path: tarballPath, manifest, files, sizeBytes, problems };
}

function exportTargets(manifest: PackageManifest): string[] {
  const targets = [manifest.main, manifest.types].filter((value): value is string => !!value);

  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (subpath === "./package.json") continue;
    targets.push(...(typeof entry === "string" ? [entry] : Object.values(entry)));
  }

  return targets;
}

export function describeTarball(inspection: TarballInspection): string {
  const { manifest } = inspection;

  return [
    `${manifest.name}@${manifest.version} (${(inspection.sizeBytes / 1024).toFixed(1)} kB packed)`,
    `  dependencies: ${JSON.stringify(manifest.dependencies ?? {})}`,
    `  exports: ${JSON.stringify(manifest.exports ?? {})}`,
    `  files: ${inspection.files.join(", ")}`,
  ].join("\n");
}
