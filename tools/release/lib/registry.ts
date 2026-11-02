/**
 * Read-only npm registry access for the release decision. Absence is only ever
 * a 404: timeouts, authentication failures, server errors and malformed
 * metadata throw, so they can never be read as "version not published".
 */

export interface RegistryVersion {
  readonly dependencies: Readonly<Record<string, string>>;
}

export type RegistryLookup =
  | { readonly status: "missing" }
  | {
      readonly status: "found";
      readonly name: string;
      readonly versions: Readonly<Record<string, RegistryVersion>>;
      readonly distTags: Readonly<Record<string, string>>;
    };

export type RegistryReader = (name: string) => Promise<RegistryLookup>;

const REGISTRY = "https://registry.npmjs.org";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown, what: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`Malformed registry metadata: ${what} is not an object.`);
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Malformed registry metadata: ${what}.${key} is not a string.`);
    }
  }
  return value as Record<string, string>;
}

/** Validates an abbreviated packument (`application/vnd.npm.install-v1+json`). */
export function parsePackument(body: unknown, expectedName: string): RegistryLookup {
  if (!isRecord(body)) throw new Error("Malformed registry metadata: not a JSON object.");
  if (body["name"] !== expectedName) {
    throw new Error(
      `Malformed registry metadata: expected ${expectedName}, got ${String(body["name"])}.`,
    );
  }
  if (!isRecord(body["versions"])) {
    throw new Error("Malformed registry metadata: versions is not an object.");
  }

  const versions: Record<string, RegistryVersion> = {};
  for (const [version, manifest] of Object.entries(body["versions"])) {
    if (!isRecord(manifest)) {
      throw new Error(`Malformed registry metadata: version ${version} is not an object.`);
    }
    versions[version] = {
      dependencies:
        manifest["dependencies"] === undefined
          ? {}
          : stringRecord(manifest["dependencies"], `versions.${version}.dependencies`),
    };
  }

  return {
    status: "found",
    name: expectedName,
    versions,
    distTags: stringRecord(body["dist-tags"] ?? {}, "dist-tags"),
  };
}

export function createRegistryReader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): RegistryReader {
  return async (name) => {
    const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
    const response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 404) return { status: "missing" };
    if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}.`);

    return parsePackument(await response.json(), name);
  };
}
