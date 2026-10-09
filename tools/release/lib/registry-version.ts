const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const isExactVersion = (value: string): boolean => EXACT_SEMVER.test(value);

/**
 * The version a registry verification targets: the explicit input when given
 * (it must be an exact semver, never a dist-tag or a range), otherwise the
 * version in the package manifest.
 */
export function resolveRegistryVersion(input: string | undefined, manifestVersion: string): string {
  const explicit = input?.trim();
  const version = explicit ? explicit : manifestVersion;

  if (!isExactVersion(version)) {
    throw new Error(
      `"${version}" is not an exact semver version (dist-tags and ranges such as "next", "latest", "^0.1.0" or "*" are not accepted).`,
    );
  }

  return version;
}

export interface LatestTagVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/** A `0.0.0-*` version only reserves the package name; it is not a release. */
const isPlaceholder = (version: string): boolean => /^0\.0\.0-/.test(version);

/**
 * Whether the `latest` dist-tag is acceptable for a release published under
 * `next`. A later release must not move `latest`. The one exception is the
 * package's first real release: npm assigns `latest` itself when no `latest`
 * exists, so `latest === version` is accepted only when every other version on
 * the registry is a `0.0.0-*` placeholder.
 */
export function latestTagVerdict(
  tags: Readonly<Record<string, string>>,
  versions: readonly string[],
  version: string,
): LatestTagVerdict {
  const latest = tags["latest"];

  if (latest !== version) return { ok: true, reason: `latest is ${latest ?? "(absent)"}` };

  const others = versions.filter((other) => other !== version);

  if (others.every(isPlaceholder)) {
    return {
      ok: true,
      reason: `latest is ${version}: npm assigns latest to the first real release (other versions: ${others.join(", ") || "none"})`,
    };
  }

  return {
    ok: false,
    reason: `latest was moved to ${version} although earlier releases exist (${others.join(", ")})`,
  };
}
