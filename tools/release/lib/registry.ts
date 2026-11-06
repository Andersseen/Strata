import { createHash } from "node:crypto";

/**
 * Read-only npm registry access for the release decision. Absence is only ever
 * a 404: timeouts, authentication failures, server errors and malformed
 * metadata throw, so they can never be read as "version not published".
 *
 * Two readers, because the registry serves two kinds of document
 * (docs/research/rc0-production-qualification.md, "Publication visibility"):
 *
 *   createAuthoritativeReader  `/<name>/<version>` and `/-/package/<name>/dist-tags`: answered
 *                              uncached (`cf-cache-status: DYNAMIC`, no `cache-control`). A release
 *                              decision is taken here.
 *   createRegistryReader       the abbreviated packument `npm install` reads: CDN-cached
 *                              (`cache-control: public, max-age=300`), so it can trail the
 *                              authoritative state for minutes. Only propagation is measured here.
 */

export interface RegistryDist {
  readonly integrity: string;
  readonly tarball: string;
  /** npm recorded a provenance attestation for this version. */
  readonly provenance: boolean;
}

export interface RegistryVersion {
  readonly dependencies: Readonly<Record<string, string>>;
  /** Present on an authoritative read only. */
  readonly dist?: RegistryDist;
}

export type RegistryLookup =
  | { readonly status: "missing" }
  | {
      readonly status: "found";
      readonly name: string;
      readonly versions: Readonly<Record<string, RegistryVersion>>;
      readonly distTags: Readonly<Record<string, string>>;
    };

/** `version` is the version the caller decides about; a packument read ignores it. */
export type RegistryReader = (name: string, version: string) => Promise<RegistryLookup>;

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

/** Validates a per-version document (`/<name>/<version>`). */
export function parseVersionDocument(
  body: unknown,
  expectedName: string,
  expectedVersion: string,
): RegistryVersion {
  if (!isRecord(body)) throw new Error("Malformed registry metadata: not a JSON object.");
  if (body["name"] !== expectedName || body["version"] !== expectedVersion) {
    throw new Error(
      `Malformed registry metadata: expected ${expectedName}@${expectedVersion}, got ${String(body["name"])}@${String(body["version"])}.`,
    );
  }

  const dist = body["dist"];
  if (
    !isRecord(dist) ||
    typeof dist["integrity"] !== "string" ||
    typeof dist["tarball"] !== "string"
  ) {
    throw new Error(`Malformed registry metadata: ${expectedName}@${expectedVersion} has no dist.`);
  }

  return {
    dependencies:
      body["dependencies"] === undefined ? {} : stringRecord(body["dependencies"], "dependencies"),
    dist: {
      integrity: dist["integrity"],
      tarball: dist["tarball"],
      provenance: isRecord(dist["attestations"]) && isRecord(dist["attestations"]["provenance"]),
    },
  };
}

const encodeName = (name: string): string => name.replace("/", "%2f");

/**
 * Reads the decision state of one exact version from the uncached endpoints. `npm publish`
 * returning success does not mean this answers yet: see `VERSION_VISIBILITY` in dist-tags.ts.
 */
export function createAuthoritativeReader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): RegistryReader {
  const read = async (url: string, what: string): Promise<unknown> => {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${what}.`);

    return response.json();
  };

  return async (name, version) => {
    const [document, tags] = await Promise.all([
      read(`${REGISTRY}/${encodeName(name)}/${version}`, `${name}@${version}`),
      read(`${REGISTRY}/-/package/${encodeName(name)}/dist-tags`, `${name} dist-tags`),
    ]);

    if (document === undefined && tags === undefined) return { status: "missing" };

    return {
      status: "found",
      name,
      versions:
        document === undefined ? {} : { [version]: parseVersionDocument(document, name, version) },
      distTags: stringRecord(tags ?? {}, "dist-tags"),
    };
  };
}

/** Downloads a published tarball and computes its Subresource Integrity value. */
export function createTarballIntegrityReader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 60_000,
): (tarball: string) => Promise<string> {
  return async (tarball) => {
    const response = await fetchImpl(tarball, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${tarball}.`);

    const bytes = Buffer.from(await response.arrayBuffer());
    return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  };
}

export function createRegistryReader(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): RegistryReader {
  return async (name) => {
    const url = `${REGISTRY}/${encodeName(name)}`;
    const response = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 404) return { status: "missing" };
    if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}.`);

    return parsePackument(await response.json(), name);
  };
}
