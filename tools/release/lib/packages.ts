import { readFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../../consumer/lib/exec.ts";
import { packedTarballName } from "../../consumer/lib/fs-helpers.ts";

export interface PublishablePackage {
  readonly name: string;
  readonly dir: string;
}

const CORE: PublishablePackage = { name: "@strata-sc/core", dir: "packages/core" };
const ANALOG: PublishablePackage = { name: "@strata-sc/analog", dir: "packages/analog" };
const SERVER_COMPONENTS: PublishablePackage = {
  name: "@strata-sc/server-components",
  dir: "packages/server-components",
};

/**
 * Every package the registry release may publish, in publish order
 * (dependencies first). `@strata-sc/h3` is deliberately absent: its consumer
 * type closure is blocked by H3 v2/crossws declarations (SPEC-002), so it
 * stays out of the registry until that blocker is resolved or accepted.
 */
export const REGISTRY_PACKAGES: readonly PublishablePackage[] = [CORE, ANALOG, SERVER_COMPONENTS];

/**
 * The subset consumed by `pnpm test:package-consumer`, the controllers/Analog
 * adapter consumer. Being registry-publishable does not make a package part of
 * that test: Server Components has its own gates
 * (`test:server-component-package-consumer`, `test:server-component-registry-consumer`).
 */
export const CONTROLLER_PACKAGE_CONSUMER_PACKAGES: readonly PublishablePackage[] = [CORE, ANALOG];

/** Never published: still private. */
export const EXCLUDED_PACKAGES: readonly string[] = ["@strata-sc/h3"];

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

/** What the inspector needs from a package, independent of how it was obtained. */
export interface PackedPackage {
  readonly manifest: PackageManifest;
  /** Tarball paths relative to the package root, e.g. `dist/index.js`. */
  readonly files: readonly string[];
  /** Version of a registry package in this workspace, to check internal ranges. */
  readonly workspaceVersion?: (name: string) => string | undefined;
}

const ROOT_FILES = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
const REQUIRED_ROOT_FILES = ["package.json", "README.md", "LICENSE"];

/**
 * Layout-agnostic package rules: required root files, every `main`/`types`/
 * `exports` target present, nothing outside `dist/` and root metadata, no
 * source or test files, no non-registry dependency ranges. The expected
 * layout is derived from the manifest, never from the package name.
 */
export function inspectPackedPackage({
  manifest,
  files,
  workspaceVersion,
}: PackedPackage): string[] {
  const problems: string[] = [];

  if (manifest.private) problems.push("package is private");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version === "0.0.0") {
    problems.push(`version "${manifest.version}" is not a released semver version`);
  }

  for (const required of REQUIRED_ROOT_FILES) {
    if (!files.includes(required)) problems.push(`missing ${required}`);
  }

  for (const file of files) {
    if (!file.startsWith("dist/") && !ROOT_FILES.includes(file)) {
      problems.push(`unexpected file ${file}`);
    }
    if (/\.test\.|(^|\/)src\/|(^|\/)tsconfig[^/]*$|(^|\/)vite\.config[^/]*$/.test(file)) {
      problems.push(`source, test or config file shipped: ${file}`);
    }
  }

  const targets = exportTargets(manifest);
  if (targets.length === 0) problems.push("manifest declares no main, types or exports target");

  for (const target of targets) {
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

      const expected = workspaceVersion?.(name);
      if (expected !== undefined && range !== expected) {
        problems.push(`dependency ${name}@${range} does not match workspace version ${expected}`);
      }

      if (EXCLUDED_PACKAGES.includes(name)) problems.push(`depends on excluded package ${name}`);
    }
  }

  return problems;
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
  const problems = inspectPackedPackage({
    manifest,
    files,
    workspaceVersion: (name) => {
      const workspacePackage = REGISTRY_PACKAGES.find((pkg) => pkg.name === name);

      return workspacePackage
        ? readManifest(join(repoRoot, workspacePackage.dir)).version
        : undefined;
    },
  });

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
