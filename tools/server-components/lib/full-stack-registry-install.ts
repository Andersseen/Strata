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
import { join } from "node:path";

import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";
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
}): RegistryInstall {
  const { tmpRoot, consumerDir, env, time, tuple, artifacts } = context;
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
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--registry",
    REGISTRY,
  ];

  console.log(
    `install command: npm ${installArgs.join(" ")}  (cwd ${consumerDir}; empty user config; npm_*/pnpm_*/NODE_PATH/NODE_OPTIONS removed)`,
  );
  time("npm install (consumer, registry)", () =>
    must(run("npm", installArgs, { cwd: consumerDir, env }), "npm install"),
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

  const tree = verifyInstalledTree({ consumerDir, env });

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

/** The packed candidate from this checkout, or (with `--registry`) the published tuple. */
export function installCandidate(
  context: Parameters<typeof installRegistryConsumer>[0] extends infer C
    ? Omit<Extract<C, object>, "tuple" | "artifacts">
    : never,
  packed: (context: {
    tmpRoot: string;
    consumerDir: string;
    env: NodeJS.ProcessEnv;
    time: <T>(label: string, work: () => T) => T;
  }) => FullStackInstall,
): FullStackInstall & { readonly evidence?: RegistryEvidence } {
  if (!registryMode()) return packed(context);

  let tuple: VersionTuple;

  try {
    tuple = selectedTuple();
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

  return installRegistryConsumer({ ...context, tuple, artifacts: lookup.artifacts });
}
