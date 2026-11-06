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

/** A bounded backoff: `attempts` reads, the delay doubling from `firstDelayMs` up to `maxDelayMs`. */
export interface RetryBound {
  readonly attempts: number;
  readonly firstDelayMs: number;
  readonly maxDelayMs: number;
}

/**
 * Publication has three separate states, and each bound below belongs to one transition
 * (docs/research/rc0-production-qualification.md, "Publication visibility"):
 *
 *   ACCEPTED    `npm publish` / `changeset publish` returned success
 *   COMMITTED   the uncached `/<name>/<version>` document answers with its integrity
 *   PROPAGATED  the CDN-cached abbreviated packument `npm install` reads shows it too
 *
 * ACCEPTED is not COMMITTED. The registry's own `time[version]` of the last three provenance
 * publishes is 56 s (server-components 0.14.0), 76 s (server-components 0.15.0) and 96 s (analog
 * 0.12.1) AFTER changeset printed "Successfully published". The previous 46 s bound could not
 * survive that: Release run 42181130222 gave up 25 s before npm committed 0.15.0.
 *
 * VERSION_VISIBILITY allows about 10.5 minutes, 6.6 times the worst measurement.
 */
export const VERSION_VISIBILITY: RetryBound = {
  attempts: 24,
  firstDelayMs: 5_000,
  maxDelayMs: 30_000,
};

/** A dist-tag write read back on the uncached endpoint: about 1.8 minutes (longest seen: 8 s). */
export const DIST_TAG_VISIBILITY: RetryBound = {
  attempts: 10,
  firstDelayMs: 2_000,
  maxDelayMs: 16_000,
};

/** The packuments carry `max-age=300`: one full CDN lifetime plus margin, about 8 minutes. */
export const PACKUMENT_PROPAGATION: RetryBound = {
  attempts: 18,
  firstDelayMs: 15_000,
  maxDelayMs: 30_000,
};

/** The total wait a bound allows. */
export function boundMs({ attempts, firstDelayMs, maxDelayMs }: RetryBound): number {
  let total = 0;
  let delay = firstDelayMs;

  for (let attempt = 1; attempt < attempts; attempt++) {
    total += delay;
    delay = Math.min(delay * 2, maxDelayMs);
  }

  return total;
}

/**
 * Re-reads the dist-tags after an update until they comply, a bounded number of times.
 *
 * npm registry metadata is eventually consistent: a read right after `npm dist-tag add` can still
 * return the old tags. Two hosted Release runs (2026-11-02 and 2026-11-03) failed exactly so —
 * `next 0.2.0 → 0.14.0` succeeded, the immediate re-read still said 0.2.0 — although the update
 * had taken effect. This still fails closed: tags that remain out of policy after every attempt
 * are an error carrying the last tags read.
 */
export async function awaitCompliantDistTags(
  read: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>,
  version: string,
  wait: (ms: number) => Promise<void>,
  options: RetryBound = DIST_TAG_VISIBILITY,
): Promise<{ readonly tags: Readonly<Record<string, string>>; readonly attempts: number }> {
  let delay = options.firstDelayMs;
  let tags: Readonly<Record<string, string>> = {};

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    tags = await read();
    if (planDistTags(tags, version).length === 0) return { tags, attempts: attempt };
    if (attempt < options.attempts) {
      await wait(delay);
      delay = Math.min(delay * 2, options.maxDelayMs);
    }
  }

  throw new Error(
    `dist-tags still out of policy after the update (${options.attempts} reads): ${JSON.stringify(tags)}`,
  );
}

/**
 * A version npm accepted that the bound never saw committed. Deliberately not "publish failed":
 * the version may still appear, so the remedy is a re-run, never a republish.
 */
export class VersionVisibilityLag extends Error {
  override readonly name = "VersionVisibilityLag";
}

/**
 * After `changeset publish` reported success, npm may not show the new VERSION for a while
 * (Release run 42034642481: published, then "not on npm; skipping" seconds later, so `next` was
 * never moved and verification failed; run 42181130222: not visible after 46 s, committed at 76 s).
 * A package this run published is therefore re-read with a bounded backoff instead of being
 * skipped. A read that throws (timeout, 5xx) counts as "not yet" and is named in the final error,
 * so an outage reads differently from lag.
 */
export async function awaitVersionVisible(
  isVisible: () => boolean | Promise<boolean>,
  wait: (ms: number) => Promise<void>,
  options: RetryBound = VERSION_VISIBILITY,
): Promise<number> {
  let delay = options.firstDelayMs;
  let unreadable: string | undefined;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      if (await isVisible()) return attempt;
      unreadable = undefined;
    } catch (error) {
      unreadable = error instanceof Error ? error.message : String(error);
    }
    if (attempt < options.attempts) {
      await wait(delay);
      delay = Math.min(delay * 2, options.maxDelayMs);
    }
  }

  const span = `${options.attempts} reads over ${Math.round(boundMs(options) / 1000)} s`;

  if (unreadable !== undefined) {
    throw new Error(`the registry was unreadable on the last of ${span}: ${unreadable}`);
  }

  throw new VersionVisibilityLag(
    `VISIBILITY LAG: npm accepted this publish but the version is still not committed after ${span}. ` +
      "Do not republish. Re-run the failed Release job: it is idempotent and resumes from the registry state.",
  );
}
