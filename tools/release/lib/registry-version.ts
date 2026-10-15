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
