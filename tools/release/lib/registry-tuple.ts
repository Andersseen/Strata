import { isExactVersion, resolveRegistryVersion } from "./registry-version.ts";

/**
 * The published-registry identity of the full-stack package combination:
 * three exact versions, the registry's own description of each artifact, and the
 * pure checks that decide whether an installed consumer really holds them.
 */

export const TUPLE_PACKAGES = [
  "@strata-sc/core",
  "@strata-sc/analog",
  "@strata-sc/server-components",
] as const;

export type TuplePackage = (typeof TUPLE_PACKAGES)[number];
export type VersionTuple = Readonly<Record<TuplePackage, string>>;

/** What `npm view <name>@<version>` says about one published artifact. */
export interface RegistryArtifact {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface LockEntry {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
}

const ENV_NAMES: Readonly<Record<TuplePackage, string>> = {
  "@strata-sc/core": "STRATA_REGISTRY_CORE_VERSION",
  "@strata-sc/analog": "STRATA_REGISTRY_ANALOG_VERSION",
  "@strata-sc/server-components": "STRATA_REGISTRY_SERVER_COMPONENTS_VERSION",
};

export const tupleEnvNames = (): Readonly<Record<TuplePackage, string>> => ENV_NAMES;

/**
 * Exact versions only: an explicit input wins over the manifest, and a dist-tag
 * or a range is refused with the offending package named.
 */
export function resolveTuple(
  inputs: Readonly<Partial<Record<TuplePackage, string | undefined>>>,
  manifestVersions: Readonly<Record<TuplePackage, string>>,
): VersionTuple {
  const entries = TUPLE_PACKAGES.map((name) => {
    try {
      return [name, resolveRegistryVersion(inputs[name], manifestVersions[name])] as const;
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  });

  return Object.fromEntries(entries) as VersionTuple;
}

export function tupleFromEnv(
  env: NodeJS.ProcessEnv,
  manifestVersions: Readonly<Record<TuplePackage, string>>,
): VersionTuple {
  return resolveTuple(
    Object.fromEntries(TUPLE_PACKAGES.map((name) => [name, env[ENV_NAMES[name]]])),
    manifestVersions,
  );
}

/** Pure parse of `npm view <spec> name version dist.tarball dist.integrity dependencies --json`. */
export function parseRegistryView(json: string): RegistryArtifact | undefined {
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }

  const view = (Array.isArray(value) ? value.at(-1) : value) as
    Record<string, unknown> | null | undefined;
  const dist = (view?.["dist"] ?? {}) as Record<string, unknown>;
  const tarball = view?.["dist.tarball"] ?? dist["tarball"];
  const integrity = view?.["dist.integrity"] ?? dist["integrity"];

  if (
    typeof view?.["name"] !== "string" ||
    typeof view["version"] !== "string" ||
    typeof tarball !== "string" ||
    typeof integrity !== "string"
  ) {
    return undefined;
  }

  return {
    name: view["name"],
    version: view["version"],
    tarball,
    integrity,
    dependencies: (view["dependencies"] ?? {}) as Record<string, string>,
  };
}

/**
 * Coherence of the selected tuple: the analog artifact must pin the selected core.
 * Only an exact pin is accepted, because that is how Strata publishes it.
 */
export function tupleProblems(
  tuple: VersionTuple,
  artifacts: Readonly<Record<TuplePackage, RegistryArtifact>>,
): string[] {
  const problems: string[] = [];

  for (const name of TUPLE_PACKAGES) {
    const artifact = artifacts[name];

    if (artifact.name !== name || artifact.version !== tuple[name]) {
      problems.push(
        `${name}@${tuple[name]}: the registry answered ${artifact.name}@${artifact.version}`,
      );
    }
    if (!isExactVersion(artifact.version) || !/^https:\/\//.test(artifact.tarball)) {
      problems.push(`${name}@${tuple[name]}: no https tarball URL / exact version`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(artifact.integrity)) {
      problems.push(`${name}@${tuple[name]}: no sha512 integrity`);
    }
  }

  const pinned = artifacts["@strata-sc/analog"].dependencies["@strata-sc/core"];

  if (pinned !== tuple["@strata-sc/core"]) {
    problems.push(
      `@strata-sc/analog@${tuple["@strata-sc/analog"]} pins @strata-sc/core ${pinned ?? "(nothing)"}, not the selected ${tuple["@strata-sc/core"]}`,
    );
  }

  return problems;
}

/**
 * The consumer's package-lock against the registry's description of the tuple:
 * every package resolves from that exact tarball URL with that exact integrity,
 * through no local, workspace or git source, and nothing else from @strata-sc.
 */
export function lockProblems(
  tuple: VersionTuple,
  artifacts: Readonly<Record<TuplePackage, RegistryArtifact>>,
  lock: { readonly packages?: Readonly<Record<string, LockEntry>> },
): string[] {
  const problems: string[] = [];
  const packages = lock.packages ?? {};

  for (const name of TUPLE_PACKAGES) {
    const entry = packages[`node_modules/${name}`];
    const artifact = artifacts[name];

    if (!entry) {
      problems.push(`${name}: no lock entry`);
      continue;
    }
    if (entry.version !== tuple[name]) {
      problems.push(`${name}: locked ${entry.version ?? "(none)"}, selected ${tuple[name]}`);
    }
    if (entry.resolved !== artifact.tarball) {
      problems.push(
        `${name}: resolved ${entry.resolved ?? "(none)"}, registry ${artifact.tarball}`,
      );
    }
    if (entry.integrity !== artifact.integrity) {
      problems.push(`${name}: integrity differs from the registry's`);
    }
  }

  for (const [key, entry] of Object.entries(packages)) {
    const strata = key.match(/node_modules\/(@strata-sc\/[^/]+)$/)?.[1];

    if (strata && !(TUPLE_PACKAGES as readonly string[]).includes(strata)) {
      problems.push(`${key}: an unexpected Strata package`);
    }
    if (key.includes("@strata-sc/") && key !== `node_modules/${strata}`) {
      problems.push(`${key}: a nested copy of a Strata package`);
    }
    if (/^(file|link|git|workspace|portal):/.test(entry.resolved ?? "") || entry.version === "") {
      if (key.includes("@strata-sc/")) problems.push(`${key}: local resolution ${entry.resolved}`);
    }
  }

  return problems;
}

/** A dependency spec that is not an exact registry version is a substitution. */
export const substitutionProblems = (dependencies: Readonly<Record<string, string>>): string[] =>
  TUPLE_PACKAGES.flatMap((name) => {
    const spec = dependencies[name] ?? "";

    return isExactVersion(spec) ? [] : [`${name}: "${spec}" is not an exact registry version`];
  });
