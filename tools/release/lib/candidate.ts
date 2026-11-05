import { createHash } from "node:crypto";

import { TUPLE_PACKAGES } from "./registry-tuple.ts";
import type { RegistryArtifact, TuplePackage, VersionTuple } from "./registry-tuple.ts";

/**
 * The identity of one FROZEN release candidate of the full-stack consumer: the exact published
 * Strata artifacts, the complete npm dependency tree that was qualified with them (as npm's own
 * package-lock), and the toolchain around it. Pure functions only; the runner
 * (tools/server-components/lib/full-stack-registry-install.ts) does the I/O.
 *
 * Two install modes use this:
 *
 *   FRESH INSTALL    `npm install` of pinned direct dependencies; transitive versions float with
 *                    the registry. Detects ecosystem drift. Can CAPTURE a candidate.
 *   FROZEN CANDIDATE `npm ci` of a captured lockfile. Reproduces the exact qualified combination
 *                    and refuses anything that differs from the record.
 */

export const CANDIDATE_SCHEMA = 1;
export const REGISTRY_ORIGIN = "https://registry.npmjs.org/";

/** The installs a full-stack candidate consists of (the TypeScript 5.9 declaration consumer is a second tree). */
export const CANDIDATE_TREES = ["consumer", "consumer-ts59"] as const;
export type CandidateTree = (typeof CANDIDATE_TREES)[number];

export interface LockedPackage {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  /** Shipped inside its parent's tarball (`bundleDependencies`): covered by the parent's integrity. */
  readonly inBundle?: boolean;
  readonly dev?: boolean;
  readonly optional?: boolean;
  readonly devOptional?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface PackageLock {
  readonly name?: string;
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockedPackage>>;
}

export interface Toolchain {
  readonly node: string;
  readonly npm: string;
  readonly playwright: string;
  readonly chromium: string;
  readonly wrangler: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly string[];
  readonly platform: string;
}

export interface CandidateRecord {
  readonly schema: typeof CANDIDATE_SCHEMA;
  /** First 16 hex characters of the sha256 over the Strata artifacts and the lock digests. */
  readonly id: string;
  readonly capturedAt: string;
  /** The Strata checkout the capture ran from (qualification tooling and fixture source). */
  readonly sourceSha: string;
  /** sha256 over the fixture's authored sources at capture time (informational). */
  readonly fixtureSourceDigest: string;
  readonly registry: string;
  readonly strata: Readonly<
    Record<TuplePackage, { version: string; tarball: string; integrity: string }>
  >;
  /** The consumer manifest's direct dependencies, exactly as installed. */
  readonly direct: {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  readonly trees: Readonly<
    Record<CandidateTree, { digest: string; packages: number; lockfileVersion: number }>
  >;
  /** Resolved versions of the framework tuple (from the consumer tree). */
  readonly resolved: Readonly<Record<string, string>>;
  readonly toolchain: Toolchain;
}

/** The framework packages whose resolved version is part of the record's summary. */
export const RESOLVED_SUMMARY = [
  "@angular/core",
  "@angular/common",
  "@angular/compiler",
  "@angular/compiler-cli",
  "@angular/platform-browser",
  "@angular/platform-server",
  "@angular/router",
  "@angular/build",
  "@analogjs/platform",
  "@analogjs/router",
  "@analogjs/vite-plugin-angular",
  "@analogjs/vite-plugin-nitro",
  "nitropack",
  "h3",
  "vite",
  "rolldown",
  "esbuild",
  "typescript",
  "rxjs",
  "tslib",
  "zod",
  "wrangler",
  "workerd",
  "miniflare",
] as const;

// ---------------------------------------------------------------------------
// Digests

/** JSON with object keys sorted at every level, so equal data always hashes equally. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The digest of a dependency tree: npm's lockfile version and every `packages` entry (path,
 * version, resolved URL, integrity, flags, declared ranges). Formatting and key order do not count.
 */
export const lockDigest = (lock: PackageLock): string =>
  sha256(stableJson({ lockfileVersion: lock.lockfileVersion, packages: lock.packages ?? {} }));

export function candidateId(
  strata: CandidateRecord["strata"],
  trees: CandidateRecord["trees"],
): string {
  return sha256(
    stableJson({
      strata: Object.fromEntries(TUPLE_PACKAGES.map((n) => [n, strata[n].integrity])),
      trees: Object.fromEntries(CANDIDATE_TREES.map((t) => [t, trees[t].digest])),
    }),
  ).slice(0, 16);
}

/** The package name of a lock key: `node_modules/a/node_modules/@s/b` → `@s/b`. */
export const lockKeyName = (key: string): string =>
  key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);

/** Resolved version of `name` at the top of the consumer tree, if any. */
export const topLevelVersion = (lock: PackageLock, name: string): string | undefined =>
  lock.packages?.[`node_modules/${name}`]?.version;

export function resolvedSummary(lock: PackageLock): Record<string, string> {
  return Object.fromEntries(
    RESOLVED_SUMMARY.flatMap((name) => {
      const version = topLevelVersion(lock, name);

      return version ? [[name, version]] : [];
    }),
  );
}

// ---------------------------------------------------------------------------
// Problems: each function returns human-readable reasons; empty means acceptable.

/**
 * Every installed package must come from the public npm registry as an exact version with a
 * sha512 integrity: no workspace link, no file/git/tarball URL, no missing integrity.
 */
export function lockSourceProblems(lock: PackageLock): string[] {
  const problems: string[] = [];

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue;
    if (entry.link) {
      problems.push(`${key}: a link (workspace or local alias), not a registry package`);
      continue;
    }
    if (entry.inBundle) {
      if (entry.resolved) problems.push(`${key}: a bundled dependency with its own source`);
      continue;
    }
    if (!entry.resolved?.startsWith(REGISTRY_ORIGIN)) {
      problems.push(
        `${key}: resolved from ${entry.resolved ?? "(nothing)"}, not ${REGISTRY_ORIGIN}`,
      );
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) {
      problems.push(`${key}: no sha512 integrity`);
    }
    if (!entry.version) problems.push(`${key}: no exact version`);
  }

  return problems;
}

/** Two copies of a package that must be a singleton (one framework instance) are a defect. */
export const SINGLETONS = [
  "@angular/core",
  "@angular/common",
  "@angular/compiler",
  "@angular/platform-browser",
  "@angular/platform-server",
  "@angular/router",
  "@strata-sc/core",
  "@strata-sc/analog",
  "@strata-sc/server-components",
  "rxjs",
  "typescript",
  "h3",
  "nitropack",
] as const;

/**
 * Packages that may exist more than once in the tree but must be ONE copy on the application's
 * build path: a nested copy under one of these parents would be a second instance in the build.
 * (`@angular/build` and `vitest` carry their own Vite for their own dev/test servers; the consumer
 * builds with Analog's, which must be the top-level one.)
 */
export const BUILD_PATH_SINGLETONS: Readonly<Record<string, readonly string[]>> = {
  vite: [
    "@analogjs/platform",
    "@analogjs/vite-plugin-angular",
    "@analogjs/vite-plugin-nitro",
    "@strata-sc/server-components",
    "nitropack",
  ],
};

export function duplicateProblems(lock: PackageLock): string[] {
  const seen = new Map<string, string[]>();

  for (const key of Object.keys(lock.packages ?? {})) {
    if (key === "") continue;
    const name = lockKeyName(key);

    if ((SINGLETONS as readonly string[]).includes(name)) {
      seen.set(name, [...(seen.get(name) ?? []), `${key}@${lock.packages![key]!.version}`]);
    }
  }

  const nested = Object.entries(BUILD_PATH_SINGLETONS).flatMap(([name, parents]) =>
    parents
      .map((parent) => `node_modules/${parent}/node_modules/${name}`)
      .filter((key) => lock.packages?.[key])
      .map((key) => `${name}: a second copy on the build path (${key})`),
  );

  return [
    ...[...seen.entries()]
      .filter(([, copies]) => copies.length > 1)
      .map(([name, copies]) => `${name}: ${copies.length} copies (${copies.join(", ")})`),
    ...nested,
  ];
}

/** The private, experimental `@strata-sc/h3` must never be part of a candidate. */
export function privatePackageProblems(lock: PackageLock): string[] {
  return Object.keys(lock.packages ?? {})
    .filter((key) => lockKeyName(key) === "@strata-sc/h3")
    .map((key) => `${key}: the private @strata-sc/h3 package is installed`);
}

/** The lock's Strata entries against the record (version, tarball URL and integrity). */
export function strataLockProblems(record: CandidateRecord, lock: PackageLock): string[] {
  return TUPLE_PACKAGES.flatMap((name) => {
    const entry = lock.packages?.[`node_modules/${name}`];
    const expected = record.strata[name];

    if (!entry) return [`${name}: missing from the lock`];

    return [
      ...(entry.version === expected.version
        ? []
        : [`${name}: locked ${entry.version}, candidate ${expected.version}`]),
      ...(entry.resolved === expected.tarball
        ? []
        : [`${name}: resolved ${entry.resolved}, candidate ${expected.tarball}`]),
      ...(entry.integrity === expected.integrity
        ? []
        : [`${name}: integrity ${entry.integrity}, candidate ${expected.integrity}`]),
    ];
  });
}

/**
 * What the registry says NOW against the record: a version that disappeared is reported by the
 * caller as NOT AVAILABLE; a different tarball or integrity for the same version is a refusal.
 */
export function registryDriftProblems(
  record: CandidateRecord,
  artifacts: Readonly<Record<TuplePackage, RegistryArtifact>>,
): string[] {
  return TUPLE_PACKAGES.flatMap((name) => {
    const expected = record.strata[name];
    const now = artifacts[name];

    return [
      ...(now.version === expected.version
        ? []
        : [`${name}: registry answered ${now.version}, candidate ${expected.version}`]),
      ...(now.integrity === expected.integrity
        ? []
        : [`${name}@${expected.version}: registry integrity changed (${now.integrity})`]),
      ...(now.tarball === expected.tarball
        ? []
        : [`${name}@${expected.version}: registry tarball URL changed (${now.tarball})`]),
    ];
  });
}

/** The tuple a record pins, in the shape the registry tooling uses. */
export const recordTuple = (record: CandidateRecord): VersionTuple =>
  Object.fromEntries(TUPLE_PACKAGES.map((n) => [n, record.strata[n].version])) as VersionTuple;

/**
 * The fixture template's manifest, with the runner's placeholders filled from the record, must
 * declare exactly the record's direct dependencies. Anything else means the fixture moved on and
 * the candidate must be recaptured, never silently reused.
 */
export function stalenessProblems(
  record: CandidateRecord,
  template: {
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
  },
): string[] {
  const fill = (deps: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(deps).map(([name, spec]) => [
        name,
        spec === "REPLACED_BY_RUNNER" && (TUPLE_PACKAGES as readonly string[]).includes(name)
          ? record.strata[name as TuplePackage].version
          : spec,
      ]),
    );
  const problems: string[] = [];

  for (const field of ["dependencies", "devDependencies"] as const) {
    const want = fill(template[field]);
    const have = record.direct[field];

    for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
      if (want[name] !== have[name]) {
        problems.push(
          `${field}.${name}: fixture declares ${want[name] ?? "(nothing)"}, candidate ${have[name] ?? "(nothing)"}`,
        );
      }
    }
  }

  return problems;
}

/**
 * The installed `node_modules` against the lock: every locked package is installed at exactly
 * the locked version (an optional package for another platform may be absent), and nothing else
 * from the lock's namespace is missing. `installed(path)` returns the version found at a lock key.
 */
export function installedTreeProblems(
  lock: PackageLock,
  installed: (key: string) => string | undefined,
): { problems: string[]; checked: number; skippedOptional: number } {
  const problems: string[] = [];
  let checked = 0;
  let skippedOptional = 0;

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "" || !key.startsWith("node_modules/")) continue;

    const version = installed(key);

    if (version === undefined) {
      if (entry.optional || entry.devOptional) {
        skippedOptional++;
        continue;
      }
      problems.push(`${key}: locked ${entry.version} but not installed`);
      continue;
    }
    checked++;
    if (version !== entry.version) {
      problems.push(`${key}: installed ${version}, locked ${entry.version}`);
    }
  }

  return { problems, checked, skippedOptional };
}

/** Toolchain facts that must match for a reproduction to count as the same environment. */
export function toolchainProblems(record: Toolchain, now: Toolchain): string[] {
  const major = (version: string): string => version.replace(/^v/, "").split(".")[0] ?? "";
  const problems: string[] = [];

  if (major(record.node) !== major(now.node)) {
    problems.push(
      `Node major ${major(now.node)} differs from the candidate's ${major(record.node)}`,
    );
  }
  for (const field of [
    "playwright",
    "wrangler",
    "compatibilityDate",
  ] as const satisfies readonly (keyof Toolchain)[]) {
    if (record[field] !== now[field]) {
      problems.push(`${field} ${now[field]} differs from the candidate's ${record[field]}`);
    }
  }
  if (record.compatibilityFlags.join(",") !== now.compatibilityFlags.join(",")) {
    problems.push(
      `compatibility flags [${now.compatibilityFlags.join(",")}] differ from the candidate's [${record.compatibilityFlags.join(",")}]`,
    );
  }

  return problems;
}

/** Structural validation of a record read from disk. */
export function recordProblems(value: unknown): string[] {
  const record = value as Partial<CandidateRecord> | null;
  const problems: string[] = [];

  if (!record || typeof record !== "object") return ["not an object"];
  if (record.schema !== CANDIDATE_SCHEMA) problems.push(`schema ${String(record.schema)}`);
  for (const name of TUPLE_PACKAGES) {
    const entry = record.strata?.[name];

    if (!entry?.version || !entry.tarball?.startsWith("https://") || !entry.integrity) {
      problems.push(`strata.${name} incomplete`);
    }
  }
  for (const tree of CANDIDATE_TREES) {
    if (!/^[0-9a-f]{64}$/.test(record.trees?.[tree]?.digest ?? "")) {
      problems.push(`trees.${tree}.digest missing`);
    }
  }
  if (record.strata && record.trees && problems.length === 0) {
    const id = candidateId(record.strata, record.trees);

    if (record.id !== id) problems.push(`id ${record.id} does not match its content (${id})`);
  }
  if (!/^[0-9a-f]{40}$/.test(record.sourceSha ?? "")) problems.push("sourceSha missing");

  return problems;
}
