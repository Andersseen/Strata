/**
 * npm dist-tag policy for the registry packages (ADR-005):
 *
 * - a stable version (`1.2.3`, including `0.x`) is released on `latest`;
 * - a prerelease (`1.0.0-rc.1`, from `changeset pre enter next`) is released on `next`;
 * - `next` is never left behind `latest`, so `@next` always installs the newest
 *   build, stable or prerelease;
 * - no tag is ever moved backwards.
 */

export type DistTag = "latest" | "next";

interface ParsedVersion {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(version: string): ParsedVersion {
  const match = SEMVER.exec(version);

  if (!match) throw new Error(`"${version}" is not an exact semver version.`);

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);

  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: negative when `a` < `b`, 0 when equal, positive when `a` > `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i++) {
    const diff = left.core[i]! - right.core[i]!;
    if (diff !== 0) return diff;
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    // A release outranks any prerelease of the same core version.
    return right.prerelease.length - left.prerelease.length;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const diff = compareIdentifiers(l, r);
    if (diff !== 0) return diff;
  }

  return 0;
}

export const isPrerelease = (version: string): boolean => parse(version).prerelease.length > 0;

/** The channel a version is released on. */
export const distTagFor = (version: string): DistTag => (isPrerelease(version) ? "next" : "latest");

export interface DistTagChange {
  readonly tag: DistTag;
  readonly from: string | undefined;
  readonly to: string;
}

/**
 * The dist-tag moves that bring a published `version` in line with the policy.
 * Empty when the tags already comply. Never moves a tag to an older version.
 */
export function planDistTags(
  tags: Readonly<Record<string, string>>,
  version: string,
): readonly DistTagChange[] {
  const changes: DistTagChange[] = [];
  const behind = (tag: DistTag) => {
    const current = tags[tag];
    return current === undefined || compareVersions(current, version) < 0;
  };

  const channel = distTagFor(version);
  if (behind(channel)) changes.push({ tag: channel, from: tags[channel], to: version });
  if (channel === "latest" && tags["next"] !== undefined && behind("next")) {
    changes.push({ tag: "next", from: tags["next"], to: version });
  }

  return changes;
}
