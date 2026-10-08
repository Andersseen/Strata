/**
 * The `publishedPackages` output of `changesets/action`: a JSON array of
 * `{ name, version }` for the packages that release actually published.
 */
export interface PublishedPackage {
  readonly name: string;
  readonly version: string;
}

/** Exact version of `name` among the published packages, or undefined if it was not published. */
export function publishedVersion(json: string | undefined, name: string): string | undefined {
  if (!json?.trim()) return undefined;

  const parsed: unknown = JSON.parse(json);

  if (!Array.isArray(parsed)) throw new Error("publishedPackages is not a JSON array.");

  const matches = parsed.filter(
    (entry): entry is PublishedPackage =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as PublishedPackage).name === name &&
      typeof (entry as PublishedPackage).version === "string",
  );

  if (matches.length > 1)
    throw new Error(`${name} appears ${matches.length} times in publishedPackages.`);

  const version = matches[0]?.version;

  if (version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${name} published version "${version}" is not an exact semver version.`);
  }

  return version;
}
