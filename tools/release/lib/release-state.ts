import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { planDistTags } from "./dist-tags.ts";
import type { RegistryReader } from "./registry.ts";

/**
 * The release decision. `changesets/action` treats any Changeset file as
 * "versioning pending": when every file is empty (qualification-only work) it
 * prints "All changesets are empty. Not creating PR", reports
 * `hasChangesets=true` and never runs its publish script, so an already
 * versioned, unpublished manifest was silently left behind with a green run.
 * The state is derived from the Changesets contents and the registry instead.
 */
export type ReleaseState =
  "VERSION_REQUIRED" | "PUBLISH_REQUIRED" | "ALREADY_PUBLISHED" | "BLOCKED";

export interface LocalPackage {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
}

export interface ChangesetCounts {
  readonly empty: number;
  readonly nonEmpty: number;
}

export interface ReleaseDecision {
  readonly state: ReleaseState;
  readonly reason: string;
  /** Public packages whose exact manifest version is not on npm yet. */
  readonly unpublished: readonly string[];
  readonly published: readonly string[];
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** A Changeset is empty when its frontmatter declares no package release. */
export function isEmptyChangeset(source: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n?---/.exec(source.trimStart());
  if (!match) throw new Error("Changeset has no frontmatter.");

  return match[1]!.trim() === "";
}

export function changesetFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
    .map((file) => join(dir, file));
}

export function countChangesets(dir: string): ChangesetCounts & { readonly emptyFiles: string[] } {
  const emptyFiles: string[] = [];
  let nonEmpty = 0;

  for (const file of changesetFiles(dir)) {
    if (isEmptyChangeset(readFileSync(file, "utf8"))) emptyFiles.push(file);
    else nonEmpty++;
  }

  return { empty: emptyFiles.length, nonEmpty, emptyFiles };
}

/** Removes empty Changesets from the (ephemeral) release checkout so Changesets sees none. */
export function discardEmptyChangesets(files: readonly string[]): void {
  for (const file of files) rmSync(file);
}

const blocked = (reason: string): ReleaseDecision => ({
  state: "BLOCKED",
  reason,
  unpublished: [],
  published: [],
});

export async function classifyRelease(input: {
  readonly changesets: ChangesetCounts;
  readonly packages: readonly LocalPackage[];
  readonly readRegistry: RegistryReader;
}): Promise<ReleaseDecision> {
  const { changesets, readRegistry } = input;
  const packages = input.packages.filter((pkg) => !pkg.private);

  if (changesets.nonEmpty > 0) {
    return {
      state: "VERSION_REQUIRED",
      reason: `${changesets.nonEmpty} pending Changeset(s) follow the Version Packages PR flow`,
      unpublished: [],
      published: [],
    };
  }

  for (const pkg of packages) {
    if (!EXACT_SEMVER.test(pkg.version) || pkg.version === "0.0.0") {
      return blocked(`${pkg.name} has no releasable version ("${pkg.version}")`);
    }
  }

  const published: string[] = [];
  const unpublished: string[] = [];

  for (const pkg of packages) {
    try {
      const lookup = await readRegistry(pkg.name);
      const present = lookup.status === "found" && pkg.version in lookup.versions;
      (present ? published : unpublished).push(pkg.name);
    } catch (error) {
      return blocked(
        `registry state of ${pkg.name} is unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (unpublished.length === 0) {
    return {
      state: "ALREADY_PUBLISHED",
      reason: "every public package version is already on npm",
      unpublished,
      published,
    };
  }

  const problems = dependencyProblems(packages, new Set(unpublished));
  if (problems.length > 0) return blocked(`dependency mismatch: ${problems.join("; ")}`);

  return {
    state: "PUBLISH_REQUIRED",
    reason:
      `${unpublished.length} unpublished version(s)` +
      (published.length > 0 ? ` (partial release; ${published.length} already published)` : "") +
      (changesets.empty > 0
        ? `; ${changesets.empty} empty Changeset(s) do not block publishing`
        : ""),
    unpublished,
    published,
  };
}

/** Internal dependencies must be workspace links or the exact local version, and be on npm or released together. */
function dependencyProblems(
  packages: readonly LocalPackage[],
  unpublished: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const local = new Map(packages.map((pkg) => [pkg.name, pkg]));

  for (const pkg of packages) {
    if (!unpublished.has(pkg.name)) continue;

    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      const target = local.get(dep);
      if (!target) continue;
      if (!range.startsWith("workspace:") && range !== target.version) {
        problems.push(`${pkg.name} requires ${dep}@${range}, workspace is ${target.version}`);
      }
    }
  }

  return problems;
}

export interface PublicationVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Registry truth after a release: every public package must be on npm at its
 * exact manifest version, with the right internal dependency versions and
 * policy-compliant dist-tags. A publish step that silently did nothing fails
 * here because nothing but the registry can satisfy it.
 */
export async function verifyPublication(input: {
  readonly packages: readonly LocalPackage[];
  readonly readRegistry: RegistryReader;
}): Promise<PublicationVerdict> {
  const packages = input.packages.filter((pkg) => !pkg.private);
  const local = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const problems: string[] = [];

  for (const pkg of packages) {
    let lookup;
    try {
      lookup = await input.readRegistry(pkg.name);
    } catch (error) {
      problems.push(
        `${pkg.name}: registry unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }

    const published = lookup.status === "found" ? lookup.versions[pkg.version] : undefined;
    if (lookup.status !== "found" || !published) {
      problems.push(`${pkg.name}@${pkg.version} is not on the npm registry`);
      continue;
    }

    for (const [dep, range] of Object.entries(published.dependencies)) {
      const target = local.get(dep);
      if (target && range !== target.version) {
        problems.push(
          `${pkg.name}@${pkg.version} depends on ${dep}@${range}, expected ${target.version}`,
        );
      }
    }

    for (const { tag, from, to } of planDistTags(lookup.distTags, pkg.version)) {
      problems.push(`${pkg.name} dist-tag "${tag}" is ${from ?? "absent"}, expected ${to}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Re-runs `verify` with a bounded backoff while its ONLY problems are registry read-after-write lag:
 * a version not yet visible on npm right after a publish, or a dist-tag not yet showing the value the
 * align step just wrote. Release run 42048951547 moved `@strata-sc/analog` `next` 0.12.0 → 0.12.1,
 * saw it on the full packument, and 0.4 s later this step's abbreviated-packument read still said
 * 0.12.0 (a separately cached document); npm then served 0.12.1 everywhere. Any other problem (a
 * dependency range) is returned at once, and the last verdict is returned when the bound is reached,
 * so a publish that did nothing or a tag that really is wrong still fails.
 */
export async function verifyPublicationEventually(
  verify: () => Promise<PublicationVerdict>,
  wait: (ms: number) => Promise<void>,
  options: { attempts: number; firstDelayMs: number; maxDelayMs: number } = {
    attempts: 6,
    firstDelayMs: 2_000,
    maxDelayMs: 16_000,
  },
): Promise<PublicationVerdict & { readonly attempts: number }> {
  let delay = options.firstDelayMs;
  let verdict = await verify();

  for (let attempt = 1; ; attempt++) {
    const onlyLag =
      !verdict.ok &&
      verdict.problems.every(
        (problem) =>
          problem.endsWith(" is not on the npm registry") ||
          /^@strata-sc\/[a-z0-9-]+ dist-tag "(latest|next)" is [^,]+, expected \S+$/.test(problem),
      );

    if (verdict.ok || !onlyLag || attempt >= options.attempts)
      return { ...verdict, attempts: attempt };
    await wait(delay);
    delay = Math.min(delay * 2, options.maxDelayMs);
    verdict = await verify();
  }
}
