import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { chromium } from "playwright";

import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";
import {
  CANDIDATE_SCHEMA,
  CANDIDATE_TREES,
  candidateId,
  duplicateProblems,
  installedTreeProblems,
  lockDigest,
  lockSourceProblems,
  privatePackageProblems,
  recordProblems,
  recordTuple,
  registryDriftProblems,
  resolvedSummary,
  stalenessProblems,
  strataLockProblems,
  toolchainProblems,
} from "../../release/lib/candidate.ts";
import type {
  CandidateRecord,
  CandidateTree,
  PackageLock,
  Toolchain,
} from "../../release/lib/candidate.ts";
import { inspectTarball, readManifest } from "../../release/lib/packages.ts";
import {
  TUPLE_PACKAGES,
  lockProblems,
  parseRegistryView,
  substitutionProblems,
  tupleFromEnv,
  tupleProblems,
} from "../../release/lib/registry-tuple.ts";
import type {
  LockEntry,
  RegistryArtifact,
  VersionTuple,
} from "../../release/lib/registry-tuple.ts";

import {
  ANALOG,
  Abort,
  CORE,
  FULL_STACK_PACKAGES as PACKAGES,
  NOT_SOURCE,
  all,
  fixtureTemplate,
  must,
  sanitize,
  sha256,
  sha512Integrity,
  verifyInstalledTree,
} from "./full-stack-install.ts";
import type { FullStackInstall } from "./full-stack-install.ts";
import { check, repoRoot, section } from "./harness.ts";
import {
  findInstalledCopies,
  installedVersion,
  isSymlinkAnywhere,
  readTarball,
  snapshotDir,
} from "./package-consumer.ts";
import { COMPATIBILITY_DATE } from "./wrangler.ts";

/**
 * The PUBLISHED-REGISTRY half of the full-stack qualification: the three packages come from
 * https://registry.npmjs.org at exact versions, never from this checkout. Everything after
 * the install (builds, servers, browser suites) is shared with the packed qualification.
 */

export const REGISTRY = "https://registry.npmjs.org";

export type TupleLookup =
  | {
      readonly status: "available";
      readonly artifacts: Record<(typeof TUPLE_PACKAGES)[number], RegistryArtifact>;
    }
  | { readonly status: "not-available"; readonly missing: readonly string[] }
  | { readonly status: "error"; readonly detail: string };

/** The selected tuple: explicit exact versions from the environment, else the manifests. */
export function selectedTuple(): VersionTuple {
  const manifestVersions = Object.fromEntries(
    PACKAGES.map((pkg) => [pkg.name, readManifest(join(repoRoot, pkg.dir)).version]),
  ) as Record<(typeof TUPLE_PACKAGES)[number], string>;

  return tupleFromEnv(process.env, manifestVersions);
}

/** Asks the registry about each exact version; a missing version is NOT AVAILABLE, not a failure. */
export function lookupTuple(tuple: VersionTuple, env: NodeJS.ProcessEnv, cwd: string): TupleLookup {
  const artifacts: Partial<Record<(typeof TUPLE_PACKAGES)[number], RegistryArtifact>> = {};
  const missing: string[] = [];

  for (const name of TUPLE_PACKAGES) {
    const spec = `${name}@${tuple[name]}`;
    const view = run(
      "npm",
      [
        "view",
        spec,
        "name",
        "version",
        "dist.tarball",
        "dist.integrity",
        "dependencies",
        "--json",
        "--registry",
        REGISTRY,
      ],
      { cwd, env },
    );
    const output = sanitize(`${view.stdout}\n${view.stderr}`);
    const artifact = view.status === 0 ? parseRegistryView(view.stdout) : undefined;

    if (artifact) artifacts[name] = artifact;
    else if (/E404|No match found|is not in this registry/.test(output)) missing.push(spec);
    else return { status: "error", detail: `${spec}: ${output.slice(-400)}` };
  }

  return missing.length > 0
    ? { status: "not-available", missing }
    : {
        status: "available",
        artifacts: artifacts as Record<(typeof TUPLE_PACKAGES)[number], RegistryArtifact>,
      };
}

export interface RegistryEvidence {
  readonly registry: string;
  readonly packages: Record<
    string,
    { version: string; tarball: string; integrity: string; lockEntry: LockEntry | undefined }
  >;
}

export interface RegistryInstall extends FullStackInstall {
  readonly evidence: RegistryEvidence;
}

export function installRegistryConsumer(context: {
  readonly tmpRoot: string;
  readonly consumerDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly time: <T>(label: string, work: () => T) => T;
  readonly tuple: VersionTuple;
  readonly artifacts: Record<(typeof TUPLE_PACKAGES)[number], RegistryArtifact>;
  /** FROZEN CANDIDATE: reinstall this captured tree with `npm ci` instead of a fresh `npm install`. */
  readonly frozen?: FrozenCandidate;
}): RegistryInstall {
  const { tmpRoot, consumerDir, env, time, tuple, artifacts, frozen } = context;
  const manifests = PACKAGES.map((pkg) => ({
    pkg,
    manifest: readManifest(join(repoRoot, pkg.dir)),
  }));

  section("Published-registry tuple: exact versions, registry-described artifacts");

  for (const name of TUPLE_PACKAGES) {
    console.log(
      `registry: ${name}@${tuple[name]}\n  ${artifacts[name].tarball}\n  ${artifacts[name].integrity}`,
    );
  }

  const tupleOk = [
    check(
      "the selected tuple is coherent (exact versions, https tarballs, sha512 integrity, analog pins the selected core)",
      tupleProblems(tuple, artifacts).length === 0,
      tupleProblems(tuple, artifacts).join("; "),
    ),
    check(
      "no source-packed file is used: this candidate is built from nothing in the checkout",
      !existsSync(join(tmpRoot, "tarballs")),
    ),
  ];

  section("External install (npm, outside the workspace, from the registry at exact versions)");

  check(
    "the consumer lives outside the repository",
    !consumerDir.startsWith(repoRoot) && !realpathSync(tmpRoot).startsWith(realpathSync(repoRoot)),
  );
  cpSync(fixtureTemplate, consumerDir, { recursive: true });

  const consumerManifestPath = join(consumerDir, "package.json");
  const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  check(
    "the fixture template declares all three Strata packages (the runner supplies the versions)",
    PACKAGES.every(({ name }) => consumerManifest.dependencies[name] === "REPLACED_BY_RUNNER"),
  );
  if (frozen) {
    const stale = stalenessProblems(frozen.record, consumerManifest);

    tupleOk.push(
      check(
        `FROZEN CANDIDATE ${frozen.record.id}: the fixture still declares exactly the candidate's direct dependencies (otherwise recapture; never reuse a stale candidate)`,
        stale.length === 0,
        stale.join("; "),
      ),
    );
  }
  for (const name of TUPLE_PACKAGES) consumerManifest.dependencies[name] = tuple[name];
  tupleOk.push(
    check(
      "the consumer names the three Strata packages by exact registry version (no file:, link:, workspace:, range or tag)",
      substitutionProblems(consumerManifest.dependencies).length === 0 &&
        !/workspace:|link:|portal:|file:|\.\.\//.test(JSON.stringify(consumerManifest)),
      substitutionProblems(consumerManifest.dependencies).join("; "),
    ),
  );
  writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);

  const pristine = snapshotDir(consumerDir, NOT_SOURCE);
  const installArgs = [
    ...(frozen ? FROZEN_INSTALL : ["install"]),
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--registry",
    REGISTRY,
  ];

  if (frozen) placeFrozenTree(frozen, "consumer", consumerDir, consumerManifest);
  console.log(
    `install command: npm ${installArgs.join(" ")}  (cwd ${consumerDir}; empty user config; npm_*/pnpm_*/NODE_PATH/NODE_OPTIONS removed)`,
  );
  time(`npm ${installArgs[0]} (consumer, registry)`, () =>
    must(run("npm", installArgs, { cwd: consumerDir, env }), `npm ${installArgs[0]}`),
  );

  const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8")) as {
    packages: Record<string, LockEntry>;
  };
  const installOk: boolean[] = [];
  const problems = lockProblems(tuple, artifacts, lock);

  installOk.push(
    check(
      "package-lock resolves each Strata package from the registry tarball URL with the registry's sha512, and nothing else from @strata-sc",
      problems.length === 0,
      problems.join("; "),
    ),
  );

  // Negative control: the same verifier must fail on a corrupted lock.
  const tampered = structuredClone(lock);

  tampered.packages[`node_modules/${CORE.name}`] = {
    ...tampered.packages[`node_modules/${CORE.name}`],
    integrity: "sha512-tampered",
  };
  installOk.push(
    check(
      "negative control: a corrupted lock integrity is detected by the same verifier",
      lockProblems(tuple, artifacts, tampered).length > 0,
    ),
  );

  const packDir = join(tmpRoot, "registry-tarballs");

  mkdirSync(packDir, { recursive: true });

  for (const pkg of PACKAGES) {
    const artifact = artifacts[pkg.name as (typeof TUPLE_PACKAGES)[number]];
    const installed = join(consumerDir, "node_modules", pkg.name);
    const pack = run(
      "npm",
      [
        "pack",
        `${pkg.name}@${artifact.version}`,
        "--pack-destination",
        packDir,
        "--registry",
        REGISTRY,
        "--json",
      ],
      { cwd: tmpRoot, env },
    );
    const filename = (JSON.parse(pack.stdout || "[]") as { filename?: string }[])[0]?.filename;
    const tarballPath = filename ? join(packDir, filename.replace(/^@/, "").replace("/", "-")) : "";

    if (!filename || !existsSync(tarballPath)) {
      installOk.push(
        check(`${pkg.name}: the registry tarball can be downloaded`, false, sanitize(pack.stderr)),
      );
      continue;
    }

    const extracted = readTarball(
      tarballPath,
      join(tmpRoot, "registry-extracted", pkg.name.replace("@strata-sc/", "")),
    );
    const inspection = inspectTarball(repoRoot, tarballPath);
    const files = listFiles(extracted.extractedDir);
    const differing = files.filter(
      (file) =>
        !existsSync(join(installed, file)) ||
        sha256(join(installed, file)) !== sha256(join(extracted.extractedDir, file)),
    );
    const installedFiles = listFiles(installed).filter((f) => !f.startsWith("node_modules/"));

    installOk.push(
      check(
        `${pkg.name}@${artifact.version}: the downloaded tarball's sha512 equals the registry's integrity and the lock's`,
        sha512Integrity(tarballPath) === artifact.integrity &&
          lock.packages[`node_modules/${pkg.name}`]?.integrity === artifact.integrity,
        sha512Integrity(tarballPath),
      ),
      check(
        `${pkg.name}: the published artifact is externally installable (release inspector: 0 problems; no workspace:/link:/portal:/file: range)`,
        inspection.problems.length === 0 &&
          !/"(workspace|link|portal|file):/.test(
            JSON.stringify([
              extracted.manifest.dependencies,
              extracted.manifest.peerDependencies,
              extracted.manifest.optionalDependencies,
            ]),
          ),
        inspection.problems.join("; "),
      ),
      check(
        `${pkg.name}: a real directory (no symlink, junction or portal) at version ${artifact.version}`,
        existsSync(join(installed, "package.json")) &&
          !isSymlinkAnywhere(installed) &&
          lstatSync(installed).isDirectory() &&
          installedVersion(consumerDir, pkg.name) === artifact.version,
      ),
      check(
        `${pkg.name}: installed files are byte-identical to the registry tarball's (${files.length} files, no src/)`,
        differing.length === 0 &&
          installedFiles.join("\n") === files.join("\n") &&
          !existsSync(join(installed, "src")),
        differing.join(", "),
      ),
      check(
        `${pkg.name}: exactly one installed copy`,
        findInstalledCopies(consumerDir, pkg.name).length === 1,
        findInstalledCopies(consumerDir, pkg.name).join(", "),
      ),
    );
  }

  const strataInstalled = readdirSync(join(consumerDir, "node_modules", "@strata-sc")).sort();
  const installedAnalog = JSON.parse(
    readFileSync(join(consumerDir, "node_modules", ANALOG.name, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  installOk.push(
    check(
      "exactly @strata-sc/{analog,core,server-components} are installed (no @strata-sc/h3)",
      strataInstalled.join(",") === "analog,core,server-components",
      strataInstalled.join(","),
    ),
    check(
      "the installed @strata-sc/analog's @strata-sc/core dependency is the selected core version",
      installedAnalog.dependencies?.[CORE.name] ===
        tuple[CORE.name as (typeof TUPLE_PACKAGES)[number]],
      JSON.stringify(installedAnalog.dependencies),
    ),
  );

  installOk.push(...treeIdentityChecks("consumer", consumerDir, lock, frozen));

  const tree = verifyInstalledTree({ consumerDir, env });

  if (!frozen) captureTree("consumer", consumerDir, lock);

  const evidence: RegistryEvidence = {
    registry: REGISTRY,
    packages: Object.fromEntries(
      TUPLE_PACKAGES.map((name) => [
        name,
        {
          version: tuple[name],
          tarball: artifacts[name].tarball,
          integrity: artifacts[name].integrity,
          lockEntry: lock.packages[`node_modules/${name}`],
        },
      ]),
    ),
  };

  return {
    manifests,
    tarballs: new Map(),
    consumerManifest,
    installArgs,
    pristine,
    ok: all([...tupleOk, ...installOk, tree.ok]),
    tarballOk: all(tupleOk),
    installOk: all([...installOk, tree.ok]),
    tuple: tree.tuple,
    specs: new Map(TUPLE_PACKAGES.map((name) => [name, tuple[name]])),
    source: "registry",
    evidence,
  };
}

/** Thrown when a selected version is not on the registry: not a runtime failure. */
export class NotAvailable extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`NOT AVAILABLE on ${REGISTRY}: ${missing.join(", ")}`);
    this.missing = missing;
  }
}

export const registryMode = (): boolean => process.argv.includes("--registry");

// ---------------------------------------------------------------------------
// FRESH INSTALL vs FROZEN CANDIDATE (docs/research/m5-production-qualification.md)

/** `--frozen`: reinstall a captured candidate with `npm ci` (implies `--registry`). */
export const frozenMode = (): boolean => process.argv.includes("--frozen");

/** The committed candidate; `STRATA_CANDIDATE_DIR` selects another captured one. */
export const candidateDir = (): string =>
  process.env["STRATA_CANDIDATE_DIR"] ?? join(repoRoot, "tests", "full-stack-candidate");

/** `STRATA_CANDIDATE_CAPTURE=<dir>` (fresh registry mode only): write the qualified tree there. */
const captureTarget = (): string | undefined =>
  process.env["STRATA_CANDIDATE_CAPTURE"] || undefined;

/**
 * `npm ci` reifies exactly the captured lock. `--legacy-peer-deps` only stops npm from RE-SOLVING
 * peer edges while validating that lock: npm 10's `install` writes a lock that `ci` rejects when an
 * optional peer is unsatisfied (here `@analogjs/content@2.9.6` declares `sharp ^0.33.5` while
 * wrangler's miniflare pins `sharp 0.35.4`). It weakens nothing that is checked: the installed tree
 * must still equal the lock entry by entry, the lock digest must be unchanged, and the framework
 * peer check (`npm ls`) still runs.
 */
const FROZEN_INSTALL = ["ci", "--legacy-peer-deps"] as const;

export interface FrozenCandidate {
  readonly dir: string;
  readonly record: CandidateRecord;
}

interface CapturedTree {
  readonly manifest: unknown;
  readonly lock: PackageLock;
}

/** Module state of one run: the candidate being reproduced, or the trees being captured. */
const run_ = {
  frozen: undefined as FrozenCandidate | undefined,
  artifacts: undefined as Record<(typeof TUPLE_PACKAGES)[number], RegistryArtifact> | undefined,
  captured: new Map<CandidateTree, CapturedTree>(),
};

export function readCandidate(dir: string): FrozenCandidate {
  const path = join(dir, "candidate.json");

  if (!existsSync(path)) throw new Error(`no captured candidate at ${path}`);

  const record = JSON.parse(readFileSync(path, "utf8")) as CandidateRecord;
  const problems = recordProblems(record);

  if (problems.length > 0) throw new Error(`invalid candidate ${path}: ${problems.join("; ")}`);
  for (const tree of CANDIDATE_TREES) {
    for (const file of ["package.json", "package-lock.json"]) {
      if (!existsSync(join(dir, tree, file)))
        throw new Error(`candidate is missing ${tree}/${file}`);
    }
  }

  return { dir, record };
}

/** Puts the candidate's manifest and lock in place; the generated manifest must equal the captured one. */
function placeFrozenTree(
  frozen: FrozenCandidate,
  tree: CandidateTree,
  dir: string,
  generated: unknown,
): void {
  const captured: unknown = JSON.parse(
    readFileSync(join(frozen.dir, tree, "package.json"), "utf8"),
  );

  check(
    `FROZEN ${tree}: the manifest this run generates equals the captured manifest (same direct dependencies, exact Strata versions)`,
    JSON.stringify(captured) === JSON.stringify(generated),
    `generated ${JSON.stringify(generated).slice(0, 300)}`,
  );
  cpSync(join(frozen.dir, tree, "package-lock.json"), join(dir, "package-lock.json"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(captured, null, 2)}\n`);
}

/** Installed version at a lock key (`node_modules/a/node_modules/b`), or undefined. */
const installedAt = (dir: string) => (key: string) => {
  const manifest = join(dir, key, "package.json");

  if (!existsSync(manifest)) return undefined;

  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version;
};

/**
 * Identity checks of one installed tree, in both modes: registry-only sources, singleton
 * framework packages, no private package, the installed files equal the lock. In FROZEN mode,
 * also: the lock is byte-for-byte the captured tree (digest), and the Strata entries are the record's.
 */
function treeIdentityChecks(
  tree: CandidateTree,
  dir: string,
  lock: PackageLock,
  frozen: FrozenCandidate | undefined,
): boolean[] {
  const sources = lockSourceProblems(lock);
  const duplicates = duplicateProblems(lock);
  const privates = privatePackageProblems(lock);
  const installed = installedTreeProblems(lock, installedAt(dir));
  const digest = lockDigest(lock);

  console.log(
    `${tree}: ${Object.keys(lock.packages ?? {}).length - 1} locked packages; lock digest ${digest}; ${installed.checked} installed versions compared, ${installed.skippedOptional} optional platform packages absent`,
  );

  const results = [
    check(
      `${tree}: every locked package comes from ${REGISTRY} with an exact version and sha512 integrity (no workspace link, file:, git: or tarball URL)`,
      sources.length === 0,
      sources.slice(0, 8).join("; "),
    ),
    check(
      `${tree}: one instance of each framework singleton (Angular, Strata, RxJS, TypeScript, Vite, H3, Nitro)`,
      duplicates.length === 0,
      duplicates.join("; "),
    ),
    check(
      `${tree}: the private @strata-sc/h3 is not installed`,
      privates.length === 0,
      privates.join("; "),
    ),
    check(
      `${tree}: every installed package is exactly the version its lock entry names`,
      installed.problems.length === 0 && installed.checked > 0,
      installed.problems.slice(0, 8).join("; "),
    ),
  ];

  if (frozen) {
    const strata = strataLockProblems(frozen.record, lock);

    results.push(
      check(
        `FROZEN ${tree}: the installed lock is the captured dependency tree (digest ${frozen.record.trees[tree].digest.slice(0, 16)}…)`,
        digest === frozen.record.trees[tree].digest,
        `got ${digest}`,
      ),
      check(
        `FROZEN ${tree}: each Strata package is the candidate's exact version, tarball and integrity`,
        strata.length === 0,
        strata.join("; "),
      ),
    );
  }

  return results;
}

function captureTree(tree: CandidateTree, dir: string, lock: PackageLock): void {
  if (!captureTarget()) return;

  run_.captured.set(tree, {
    manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
    lock,
  });
}

/**
 * A further consumer of the same candidate (the TypeScript 5.9 declaration consumer): a fresh
 * `npm install` normally, the captured tree with `npm ci` in FROZEN mode. Returns the checks.
 */
export function installAuxiliaryConsumer(context: {
  readonly tree: Exclude<CandidateTree, "consumer">;
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly time: <T>(label: string, work: () => T) => T;
}): boolean {
  const { tree, dir, env, time } = context;
  const frozen = run_.frozen;
  const args = [
    ...(frozen ? FROZEN_INSTALL : ["install"]),
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
  const registryArgs = registryMode() ? ["--registry", REGISTRY] : [];

  if (frozen) {
    placeFrozenTree(frozen, tree, dir, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
  }
  time(`npm ${args[0]} (${tree})`, () =>
    must(run("npm", [...args, ...registryArgs], { cwd: dir, env }), `npm ${args[0]} (${tree})`),
  );
  if (!registryMode()) return true;

  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as PackageLock;
  const ok = all(treeIdentityChecks(tree, dir, lock, frozen));

  if (!frozen) captureTree(tree, dir, lock);

  return ok;
}

/** The toolchain of this run: Node, npm, Playwright/Chromium, the consumer's wrangler, workerd settings. */
export async function collectToolchain(
  consumerDir: string,
  env: NodeJS.ProcessEnv,
): Promise<Toolchain> {
  const require = createRequire(join(repoRoot, "package.json"));
  const playwright = (
    JSON.parse(readFileSync(require.resolve("playwright/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const browser = await chromium.launch();
  const chromiumVersion = browser.version();

  await browser.close();

  return {
    node: process.version,
    npm: run("npm", ["--version"], { cwd: consumerDir, env }).stdout.trim(),
    playwright,
    chromium: chromiumVersion,
    wrangler: installedVersion(consumerDir, "wrangler"),
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: [],
    platform: `${process.platform}-${process.arch}`,
  };
}

/** FROZEN only: the environment must match the candidate's where it decides behavior. */
export function checkFrozenToolchain(now: Toolchain): boolean {
  const frozen = run_.frozen;

  if (!frozen) return true;

  const problems = toolchainProblems(frozen.record.toolchain, now);

  console.log(
    `candidate toolchain: ${JSON.stringify(frozen.record.toolchain)}\nthis run:            ${JSON.stringify(now)}`,
  );

  return check(
    "FROZEN: Node major, Playwright, wrangler and the workerd compatibility date/flags match the candidate (exact Node/Chromium builds are reported, not required)",
    problems.length === 0,
    problems.join("; "),
  );
}

/** The active FROZEN candidate, if any (for evidence). */
export const activeCandidate = (): FrozenCandidate | undefined => run_.frozen;

/**
 * Fresh registry mode with `STRATA_CANDIDATE_CAPTURE`: after a fully passing run, writes the
 * qualified trees and their identity record. A failed run captures nothing.
 */
export function writeCapturedCandidate(context: {
  readonly passed: boolean;
  readonly toolchain: Toolchain;
  readonly sourceSha: string;
  readonly fixtureSourceDigest: string;
}): string | undefined {
  const target = captureTarget();

  if (!target) return undefined;
  if (!context.passed || !run_.artifacts) {
    console.log(`candidate capture: NOT WRITTEN (the qualification did not pass)`);

    return undefined;
  }
  for (const tree of CANDIDATE_TREES) {
    if (!run_.captured.has(tree)) throw new Error(`capture is missing the ${tree} tree`);
  }

  const consumer = run_.captured.get("consumer")!;
  const manifest = consumer.manifest as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const strata = Object.fromEntries(
    TUPLE_PACKAGES.map((name) => [
      name,
      {
        version: run_.artifacts![name].version,
        tarball: run_.artifacts![name].tarball,
        integrity: run_.artifacts![name].integrity,
      },
    ]),
  ) as CandidateRecord["strata"];
  const trees = Object.fromEntries(
    CANDIDATE_TREES.map((tree) => {
      const lock = run_.captured.get(tree)!.lock;

      return [
        tree,
        {
          digest: lockDigest(lock),
          packages: Object.keys(lock.packages ?? {}).length - 1,
          lockfileVersion: lock.lockfileVersion ?? 0,
        },
      ];
    }),
  ) as CandidateRecord["trees"];
  const record: CandidateRecord = {
    schema: CANDIDATE_SCHEMA,
    id: candidateId(strata, trees),
    capturedAt: new Date().toISOString(),
    sourceSha: context.sourceSha,
    fixtureSourceDigest: context.fixtureSourceDigest,
    registry: REGISTRY,
    strata,
    direct: { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies },
    trees,
    resolved: resolvedSummary(consumer.lock),
    toolchain: context.toolchain,
  };

  mkdirSync(target, { recursive: true });
  for (const tree of CANDIDATE_TREES) {
    const captured = run_.captured.get(tree)!;

    mkdirSync(join(target, tree), { recursive: true });
    writeFileSync(
      join(target, tree, "package.json"),
      `${JSON.stringify(captured.manifest, null, 2)}\n`,
    );
    writeFileSync(
      join(target, tree, "package-lock.json"),
      `${JSON.stringify(captured.lock, null, 2)}\n`,
    );
  }
  writeFileSync(join(target, "candidate.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`candidate capture: ${record.id} written to ${target}`);

  return record.id;
}

/** The packed candidate from this checkout, or (with `--registry`) the published tuple. */
export function installCandidate(
  context: Parameters<typeof installRegistryConsumer>[0] extends infer C
    ? Omit<Extract<C, object>, "tuple" | "artifacts" | "frozen">
    : never,
  packed: (context: {
    tmpRoot: string;
    consumerDir: string;
    env: NodeJS.ProcessEnv;
    time: <T>(label: string, work: () => T) => T;
  }) => FullStackInstall,
): FullStackInstall & { readonly evidence?: RegistryEvidence } {
  if (!registryMode() && !frozenMode()) return packed(context);

  let tuple: VersionTuple;
  let frozen: FrozenCandidate | undefined;

  try {
    if (frozenMode()) {
      frozen = readCandidate(candidateDir());
      tuple = recordTuple(frozen.record);
      if (captureTarget()) throw new Error("--frozen and STRATA_CANDIDATE_CAPTURE are exclusive");
    } else {
      tuple = selectedTuple();
    }
  } catch (error) {
    console.error(
      `invalid registry selection: ${error instanceof Error ? error.message : String(error)}`,
    );
    rmSync(context.tmpRoot, { recursive: true, force: true });
    process.exit(2);
  }

  const lookup = lookupTuple(tuple, context.env, context.tmpRoot);

  if (lookup.status === "not-available") throw new NotAvailable(lookup.missing);
  if (lookup.status === "error") throw new Error(`registry lookup failed: ${lookup.detail}`);

  run_.frozen = frozen;
  run_.artifacts = lookup.artifacts;

  if (frozen) {
    section(`FROZEN CANDIDATE ${frozen.record.id} (${frozen.dir})`);
    console.log(
      `captured ${frozen.record.capturedAt} from ${frozen.record.sourceSha}; ${TUPLE_PACKAGES.map((n) => `${n}@${tuple[n]}`).join(", ")}`,
    );

    const drift = registryDriftProblems(frozen.record, lookup.artifacts);

    if (
      !check(
        "FROZEN: the registry still describes each candidate artifact with the recorded tarball and integrity",
        drift.length === 0,
        drift.join("; "),
      )
    ) {
      throw new Abort("registry drift");
    }
  }

  return installRegistryConsumer({
    ...context,
    tuple,
    artifacts: lookup.artifacts,
    ...(frozen ? { frozen } : {}),
  });
}
