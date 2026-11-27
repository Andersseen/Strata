import { createHash } from "node:crypto";

import { planDistTags } from "./dist-tags.ts";
import { RC_REQUIREMENTS, RELEASE_PIPELINE_PATHS } from "./rc-catalog.ts";
import type { HostedProofSpec, RcPhase, RcRequirement } from "./rc-catalog.ts";
import type { RegistryLookup, RegistryReader } from "./registry.ts";

/**
 * The RC go/no-go decision (docs/specs/004-first-release-candidate.md). A verdict is computed, not
 * asserted: the ledger only says where to look. Each PASS is re-read from GitHub, each identity is
 * recomputed from git, and each published artifact is compared with npm. A row that cannot be
 * checked is a blocker, never a pass.
 */

export const LEDGER_SCHEMA = 2;
export const LEDGER_PATH = "tools/release/rc-evidence.json";
export const FROZEN_CANDIDATE_PATH = "tests/full-stack-candidate/candidate.json";
const CONFIG_PATHS = [".changeset/config.json", "package.json", "pnpm-workspace.yaml"] as const;

const STATUSES = ["PASS", "PARTIAL", "FAIL", "NOT RUN"] as const;
export type EvidenceStatus = (typeof STATUSES)[number];

export type EvidenceProof =
  | { readonly kind: "hosted-run"; readonly runId: number }
  | { readonly kind: "maintainer-decision"; readonly pullRequest: number };

export interface EvidenceRow {
  readonly id: string;
  /** Mirrors the catalog so the file reads on its own; a difference is an invalid ledger. */
  readonly gate: RcRequirement["gate"];
  readonly artifact: RcRequirement["artifact"];
  readonly status: EvidenceStatus;
  readonly proof: EvidenceProof | null;
  readonly note: string;
}

/** The code the evidence is about. Everything but `sha` is recomputed from that commit. */
export interface CandidateIdentity {
  readonly sha: string;
  /** `git rev-parse <sha>:packages`: the exact sources the tarballs are packed from. */
  readonly sourceTree: string;
  /** sha256 of pnpm-lock.yaml. */
  readonly lockDigest: string;
  /** sha256 over the release and workspace configuration. */
  readonly configDigest: string;
  readonly versions: Readonly<Record<string, string>>;
}

/** Published artifacts, and the commit whose frozen candidate and harness qualified them. */
export interface TupleIdentity {
  readonly harnessSha: string;
  readonly frozenId: string;
  readonly packages: Readonly<
    Record<string, { readonly version: string; readonly integrity: string }>
  >;
}

export interface EvidenceLedger {
  readonly schema: typeof LEDGER_SCHEMA;
  /** `1.0.0-rc.N`. */
  readonly target: string;
  /** Null until a candidate is frozen; no phase can pass without it. */
  readonly candidate: CandidateIdentity | null;
  /** The published 0.x tuple the pipeline and baseline rows were obtained on. */
  readonly baseline: TupleIdentity | null;
  /** The published RC tuple; null until it exists. */
  readonly published: (TupleIdentity & { readonly publishSha: string }) | null;
  readonly rows: readonly EvidenceRow[];
}

export interface GitFacts {
  head(): string;
  /** File content at a commit, or null when the commit or the path does not exist. */
  read(sha: string, path: string): string | null;
  /** Tree hash of a directory at a commit, or null. */
  tree(sha: string, path: string): string | null;
  /** Paths that differ between two commits; null when either commit is unknown. */
  changedPaths(from: string, to: string): readonly string[] | null;
}

export interface HostedStep {
  readonly name: string;
  readonly conclusion: string | null;
}

export interface HostedJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly steps: readonly HostedStep[];
}

export interface HostedRun {
  readonly id: number;
  readonly repository: string;
  readonly headRepository: string;
  readonly path: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly title: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobs: readonly HostedJob[];
}

export interface HostedPullRequest {
  readonly merged: boolean;
  readonly mergedBy: string | null;
  readonly mergeSha: string | null;
}

/** Live GitHub reads. A failure rejects, and a rejection is a blocker. */
export interface HostedReader {
  run(runId: number): Promise<HostedRun>;
  pullRequest(number: number): Promise<HostedPullRequest>;
}

export interface FrozenCandidate {
  readonly id: string;
  readonly strata: Readonly<
    Record<string, { readonly version: string; readonly integrity: string }>
  >;
}

export interface RcFacts {
  /** Parsed JSON: validated here, because a caller must not be able to skip that. */
  readonly ledger: unknown;
  readonly phase: RcPhase;
  /** True on the commit that is about to publish: versioning commits are then expected. */
  readonly publishing?: boolean;
  readonly repository: string;
  readonly maintainer: string;
  readonly packageNames: readonly string[];
  readonly manifestVersions: Readonly<Record<string, string>>;
  readonly pendingChangesets: number;
  readonly git: GitFacts;
  readonly hosted: HostedReader;
  readonly readRegistry: RegistryReader;
}

export interface RcBlocker {
  readonly rank: number;
  readonly id: string;
  readonly reason: string;
}

export interface RcAssessment {
  readonly phase: RcPhase;
  readonly verdict: "GO" | "NO-GO";
  readonly blockers: readonly RcBlocker[];
  /** Risks an RC may carry. Never accepted for General Availability. */
  readonly accepted: readonly {
    readonly id: string;
    readonly status: string;
    readonly note: string;
  }[];
}

const SHA = /^[0-9a-f]{40}$/;
const RC_VERSION = /^1\.0\.0-rc\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+=*$/;
const ROW_KEYS = ["artifact", "gate", "id", "note", "proof", "status"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function tupleProblems(value: unknown, label: string, names: readonly string[]): string[] {
  if (!isRecord(value)) return [`${label} is not an object`];

  const problems: string[] = [];

  if (typeof value["harnessSha"] !== "string" || !SHA.test(value["harnessSha"])) {
    problems.push(`${label}.harnessSha is not a full commit SHA`);
  }
  if (typeof value["frozenId"] !== "string" || value["frozenId"] === "") {
    problems.push(`${label}.frozenId is missing`);
  }

  const packages = isRecord(value["packages"]) ? value["packages"] : {};

  for (const name of names) {
    const entry = packages[name];

    if (!isRecord(entry) || typeof entry["version"] !== "string") {
      problems.push(`${label} has no version of ${name}`);
    } else if (typeof entry["integrity"] !== "string" || !INTEGRITY.test(entry["integrity"])) {
      problems.push(`${label} has no sha512 integrity of ${name}`);
    }
  }

  return problems;
}

function candidateProblems(value: unknown, names: readonly string[]): string[] {
  if (!isRecord(value)) return ["candidate is not an object"];

  const problems: string[] = [];

  if (typeof value["sha"] !== "string" || !SHA.test(value["sha"])) {
    problems.push("candidate.sha is not a full commit SHA");
  }
  if (typeof value["sourceTree"] !== "string" || !/^[0-9a-f]{40,64}$/.test(value["sourceTree"])) {
    problems.push("candidate.sourceTree is not a tree hash");
  }
  for (const key of ["lockDigest", "configDigest"]) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) {
      problems.push(`candidate.${key} is not a sha256`);
    }
  }

  const versions = isRecord(value["versions"]) ? value["versions"] : {};

  for (const name of names) {
    if (typeof versions[name] !== "string") problems.push(`candidate has no version of ${name}`);
  }

  return problems;
}

function rowProblems(row: unknown, seen: Set<string>): string[] {
  if (!isRecord(row)) return ["a row is not an object"];

  const id = String(row["id"]);
  const spec = RC_REQUIREMENTS.find((requirement) => requirement.id === row["id"]);

  if (typeof row["id"] !== "string" || !spec) return [`unknown requirement ${id}`];
  if (seen.has(id)) return [`duplicate row ${id}`];
  seen.add(id);

  const problems: string[] = [];
  const extra = Object.keys(row).filter((key) => !ROW_KEYS.includes(key));

  if (extra.length > 0) problems.push(`${id} has unknown fields: ${extra.join(", ")}`);
  if (row["gate"] !== spec.gate) {
    problems.push(`${id} is a ${spec.gate} requirement, the ledger says ${String(row["gate"])}`);
  }
  if (row["artifact"] !== spec.artifact) {
    problems.push(`${id} proves ${spec.artifact}, the ledger says ${String(row["artifact"])}`);
  }
  if (!(STATUSES as readonly unknown[]).includes(row["status"])) {
    problems.push(`${id} has an invalid status ${String(row["status"])}`);
  }
  if (typeof row["note"] !== "string") problems.push(`${id} has no note`);

  const proof = row["proof"];

  if (proof !== null) {
    if (!isRecord(proof)) {
      problems.push(`${id} has a malformed proof`);
    } else if (proof["kind"] !== spec.proof.kind) {
      problems.push(`${id} needs ${spec.proof.kind} proof, not ${String(proof["kind"])}`);
    } else if (proof["kind"] === "hosted-run" && !Number.isSafeInteger(proof["runId"])) {
      problems.push(`${id} has no run id`);
    } else if (
      proof["kind"] === "maintainer-decision" &&
      !Number.isSafeInteger(proof["pullRequest"])
    ) {
      problems.push(`${id} has no pull request number`);
    }
  }
  if (row["status"] === "PASS") {
    if (spec.proof.kind === "none") problems.push(`${id} cannot be proven here, so it cannot PASS`);
    else if (proof === null) problems.push(`${id} claims PASS without proof`);
  }

  return problems;
}

/** Structure only: the catalog must be covered exactly, and rows may say nothing it forbids. */
export function ledgerProblems(value: unknown, packageNames: readonly string[]): string[] {
  if (!isRecord(value)) return ["ledger is not an object"];

  const problems: string[] = [];

  if (value["schema"] !== LEDGER_SCHEMA) problems.push(`ledger schema is not ${LEDGER_SCHEMA}`);
  if (typeof value["target"] !== "string" || !RC_VERSION.test(value["target"])) {
    problems.push("ledger target is not a 1.0.0-rc.N version");
  }
  if (value["candidate"] !== null) {
    problems.push(...candidateProblems(value["candidate"], packageNames));
  }
  if (value["baseline"] !== null) {
    problems.push(...tupleProblems(value["baseline"], "baseline", packageNames));
  }
  if (value["published"] !== null) {
    problems.push(...tupleProblems(value["published"], "published", packageNames));
    const publishSha = isRecord(value["published"]) ? value["published"]["publishSha"] : undefined;

    if (typeof publishSha !== "string" || !SHA.test(publishSha)) {
      problems.push("published.publishSha is not a full commit SHA");
    }
  }

  const rows = Array.isArray(value["rows"]) ? (value["rows"] as unknown[]) : [];

  if (!Array.isArray(value["rows"])) problems.push("ledger has no rows");

  const seen = new Set<string>();

  problems.push(...rows.flatMap((row) => rowProblems(row, seen)));
  for (const { id } of RC_REQUIREMENTS) {
    if (!seen.has(id)) problems.push(`requirement ${id} is missing from the ledger`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// What a difference between two commits means

/** Cannot change a package, a test or a tool. Package READMEs are not here: they ship in tarballs. */
const isDocumentation = (path: string): boolean =>
  path.startsWith("docs/") || /^[^/]+\.md$/.test(path) || path === LEDGER_PATH;

const isVersioning = (path: string): boolean =>
  /^\.changeset\//.test(path) ||
  /^(packages|apps)\/[^/]+\/(package\.json|CHANGELOG\.md)$/.test(path);

/** A manifest with what `changeset version` writes taken out. */
function versionlessManifest(source: string): string {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  const dependencyFields = ["dependencies", "devDependencies", "peerDependencies"];

  delete manifest["version"];
  for (const field of dependencyFields) {
    const dependencies = manifest[field];

    if (!isRecord(dependencies)) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@strata-sc/")) delete dependencies[name];
    }
  }

  return JSON.stringify(manifest);
}

/**
 * Whether `changed` is what versioning alone writes. The path is not enough: a package.json can hide
 * a dependency or an export change, so each manifest is compared with its versions removed.
 */
export function onlyVersioning(
  changed: readonly string[],
  from: string,
  to: string,
  git: GitFacts,
): boolean {
  return changed.every((path) => {
    if (isDocumentation(path)) return true;
    if (!isVersioning(path)) return false;
    if (!path.endsWith("package.json")) return true;

    const before = git.read(from, path);
    const after = git.read(to, path);

    return (
      before !== null &&
      after !== null &&
      versionlessManifest(before) === versionlessManifest(after)
    );
  });
}

export const onlyDocumentation = (changed: readonly string[]): boolean =>
  changed.every(isDocumentation);

// ---------------------------------------------------------------------------
// Identity

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The identity of a commit, as `pnpm release:rc:check --print-candidate=<sha>` prints it. */
export function candidateIdentity(
  sha: string,
  git: GitFacts,
  packages: readonly { readonly name: string; readonly dir: string }[],
): CandidateIdentity | null {
  const sourceTree = git.tree(sha, "packages");
  const lock = git.read(sha, "pnpm-lock.yaml");
  const config = CONFIG_PATHS.map((path) => git.read(sha, path));

  if (sourceTree === null || lock === null || config.includes(null)) return null;

  const versions: Record<string, string> = {};

  for (const { name, dir } of packages) {
    const manifest = git.read(sha, `${dir}/package.json`);

    if (manifest === null) return null;
    versions[name] = (JSON.parse(manifest) as { version: string }).version;
  }

  return {
    sha,
    sourceTree,
    lockDigest: sha256(lock),
    configDigest: sha256(config.join("\0")),
    versions,
  };
}

// ---------------------------------------------------------------------------
// Assessment

type Block = (rank: number, id: string, reason: string) => void;

const parseFrozen = (source: string | null): FrozenCandidate | null => {
  if (source === null) return null;

  try {
    const parsed = JSON.parse(source) as FrozenCandidate;

    return typeof parsed.id === "string" && isRecord(parsed.strata) ? parsed : null;
  } catch {
    return null;
  }
};

/** The frozen candidate committed at the harness SHA must be exactly the tuple the ledger names. */
function checkTupleBinding(
  label: string,
  tuple: TupleIdentity,
  names: readonly string[],
  git: GitFacts,
  block: Block,
): void {
  const frozen = parseFrozen(git.read(tuple.harnessSha, FROZEN_CANDIDATE_PATH));

  if (!frozen) {
    block(4, `${label}-frozen-candidate`, `no frozen candidate at ${tuple.harnessSha}`);

    return;
  }
  if (frozen.id !== tuple.frozenId) {
    block(4, `${label}-frozen-candidate`, `frozen id is ${frozen.id}, ledger ${tuple.frozenId}`);
  }
  for (const name of names) {
    const recorded = frozen.strata[name];
    const claimed = tuple.packages[name];

    if (recorded?.version !== claimed?.version || recorded?.integrity !== claimed?.integrity) {
      block(
        4,
        `${label}-frozen-candidate`,
        `${name}: frozen ${recorded?.version ?? "(none)"} differs from the ledger's ${claimed?.version ?? "(none)"} or its integrity`,
      );
    }
  }
}

/** Authoritative read of one tuple: every version on npm, with the integrity the ledger holds. */
async function checkTupleOnRegistry(
  label: string,
  tuple: TupleIdentity,
  names: readonly string[],
  readRegistry: RegistryReader,
  block: Block,
): Promise<Map<string, RegistryLookup>> {
  const lookups = new Map<string, RegistryLookup>();

  for (const name of names) {
    const { version, integrity } = tuple.packages[name]!;
    let lookup: RegistryLookup;

    try {
      lookup = await readRegistry(name, version);
    } catch (error) {
      block(1, "registry-unreadable", `${name}: ${String(error)}`);
      continue;
    }

    const published = lookup.status === "found" ? lookup.versions[version] : undefined;

    if (!published) {
      block(2, `${label}-unpublished`, `${name}@${version} is not on npm`);
      continue;
    }
    if (published.dist && published.dist.integrity !== integrity) {
      block(2, `${label}-integrity`, `${name}@${version}: npm serves ${published.dist.integrity}`);
    }
    lookups.set(name, lookup);
  }

  return lookups;
}

function checkRunIdentity(
  run: HostedRun,
  spec: HostedProofSpec,
  repository: string,
  block: (reason: string) => void,
): boolean {
  let valid = true;
  const fail = (reason: string): void => {
    valid = false;
    block(reason);
  };

  if (run.repository !== repository || run.headRepository !== repository) {
    fail(`run ${run.id} is not from ${repository}`);
  }
  if (run.path.split("@")[0] !== spec.workflow) {
    fail(`run ${run.id} is ${run.path}, not ${spec.workflow}`);
  }
  if (!spec.events.includes(run.event)) {
    fail(`run ${run.id} was triggered by ${run.event}`);
  }
  if (run.event === "push" && run.headBranch !== "main") {
    fail(`run ${run.id} is a push to ${run.headBranch}, not main`);
  }
  if (spec.titleIncludes && !run.title.includes(spec.titleIncludes)) {
    fail(`run ${run.id} ("${run.title}") is not the ${spec.titleIncludes} qualification`);
  }
  for (const name of spec.jobs) {
    const jobs = run.jobs.filter((job) => job.name === name);
    const job = jobs[0];

    if (jobs.length !== 1 || !job) {
      fail(`run ${run.id} has no single job "${name}"`);
    } else if (job.status !== "completed" || job.conclusion !== "success") {
      fail(`run ${run.id} job "${name}" is ${job.status}/${job.conclusion ?? "none"}`);
    }
  }
  for (const name of spec.steps ?? []) {
    const step = run.jobs
      .filter((job) => spec.jobs.includes(job.name))
      .flatMap((job) => job.steps)
      .find((candidate) => candidate.name === name);

    if (step?.conclusion !== "success") {
      fail(`run ${run.id} step "${name}" is ${step?.conclusion ?? "absent"}`);
    }
  }

  return valid;
}

/** Is the run's commit one this requirement may reuse? */
function checkBinding(
  row: EvidenceRow,
  spec: RcRequirement,
  headSha: string,
  ledger: EvidenceLedger,
  git: GitFacts,
  block: (reason: string) => void,
): void {
  const tuple =
    spec.artifact === "baseline-registry"
      ? ledger.baseline
      : spec.artifact === "rc-registry"
        ? ledger.published
        : null;
  const anchor = spec.binding === "tuple" ? tuple?.harnessSha : ledger.candidate?.sha;

  if (!anchor) {
    block(
      `${row.id} needs ${spec.binding === "tuple" ? spec.artifact : "a candidate"} in the ledger`,
    );

    return;
  }

  // The publishing run of an RC is tied to the commit that published, not to a later harness.
  const reference = spec.id === "rc-publication" ? ledger.published?.publishSha : anchor;
  const changed = git.changedPaths(headSha, reference ?? anchor);

  if (changed === null) {
    block(`commit ${headSha} is not in this repository's history`);
  } else if (spec.binding === "pipeline") {
    const moved = changed.filter((path) => RELEASE_PIPELINE_PATHS.some((p) => p.test(path)));

    if (moved.length > 0)
      block(`the release pipeline changed since ${headSha}: ${moved.join(", ")}`);
  } else if (!onlyDocumentation(changed)) {
    const code = changed.filter((path) => !isDocumentation(path)).slice(0, 5);

    block(`obtained on ${headSha}, which differs in more than documentation: ${code.join(", ")}`);
  }
}

async function checkRow(
  row: EvidenceRow,
  spec: RcRequirement,
  facts: RcFacts,
  ledger: EvidenceLedger,
  block: (reason: string) => void,
): Promise<void> {
  if (row.status !== "PASS") {
    block(`${row.status}: ${row.note}`);

    return;
  }

  const proof = row.proof!;

  try {
    if (proof.kind === "maintainer-decision") {
      const pull = await facts.hosted.pullRequest(proof.pullRequest);

      if (!pull.merged || pull.mergedBy !== facts.maintainer || pull.mergeSha === null) {
        block(`pull request ${proof.pullRequest} was not merged by ${facts.maintainer}`);
      } else {
        checkBinding(row, spec, pull.mergeSha, ledger, facts.git, block);
      }

      return;
    }

    const run = await facts.hosted.run(proof.runId);

    if (spec.proof.kind === "hosted-run") {
      if (checkRunIdentity(run, spec.proof, facts.repository, block)) {
        checkBinding(row, spec, run.headSha, ledger, facts.git, block);
      }
    }
  } catch (error) {
    block(`hosted proof could not be read: ${String(error)}`);
  }
}

async function assessPre(facts: RcFacts, ledger: EvidenceLedger, block: Block): Promise<void> {
  const { git, packageNames, publishing = false } = facts;
  const { candidate, baseline } = ledger;

  if (!candidate) {
    block(1, "candidate-not-frozen", "the ledger names no candidate commit");
  } else {
    const packages = packageNames.map((name) => ({ name, dir: `packages/${name.split("/")[1]}` }));
    const actual = candidateIdentity(candidate.sha, git, packages);

    if (!actual) {
      block(1, "candidate-identity", `commit ${candidate.sha} cannot be read`);
    } else {
      for (const key of ["sourceTree", "lockDigest", "configDigest"] as const) {
        if (actual[key] !== candidate[key]) {
          block(1, "candidate-identity", `${key} is ${actual[key]}, ledger ${candidate[key]}`);
        }
      }
      for (const name of packageNames) {
        if (actual.versions[name] !== candidate.versions[name]) {
          block(1, "candidate-identity", `${name} is ${actual.versions[name]} at the candidate`);
        }
      }
    }

    const head = git.head();
    const changed = git.changedPaths(candidate.sha, head);

    if (changed === null) {
      block(1, "stale-ledger", `commit ${candidate.sha} is not an ancestor-readable commit`);
    } else if (
      publishing ? !onlyVersioning(changed, candidate.sha, head, git) : !onlyDocumentation(changed)
    ) {
      const code = changed.filter((path) => !isDocumentation(path)).slice(0, 5);

      block(
        1,
        "stale-ledger",
        `the ledger is for ${candidate.sha}; ${head} changed ${code.join(", ")}`,
      );
    }
  }

  if (publishing) {
    for (const name of packageNames) {
      if (facts.manifestVersions[name] !== ledger.target) {
        block(
          1,
          "wrong-version",
          `${name} is ${facts.manifestVersions[name]}, the target ${ledger.target}`,
        );
      }
    }
  } else if (facts.pendingChangesets > 0) {
    block(
      5,
      "unreleased-source",
      `${facts.pendingChangesets} Changeset(s) describe source changes no published tuple contains`,
    );
  }

  if (!baseline) {
    block(2, "baseline-not-recorded", "the ledger names no published baseline tuple");

    return;
  }

  checkTupleBinding("baseline", baseline, packageNames, git, block);

  const lookups = await checkTupleOnRegistry(
    "baseline",
    baseline,
    packageNames,
    facts.readRegistry,
    block,
  );

  // While publishing, the tags are about to move; before that they must rest on the baseline.
  if (publishing) return;
  for (const [name, lookup] of lookups) {
    if (lookup.status !== "found") continue;
    for (const { tag, from, to } of planDistTags(
      lookup.distTags,
      baseline.packages[name]!.version,
    )) {
      block(3, "dist-tag-drift", `${name} ${tag} is ${from ?? "absent"}, expected ${to}`);
    }
  }
}

async function assessPost(facts: RcFacts, ledger: EvidenceLedger, block: Block): Promise<void> {
  const { git, packageNames } = facts;
  const { candidate, published, baseline } = ledger;

  if (!candidate) block(1, "candidate-not-frozen", "the ledger names no candidate commit");
  if (!published) {
    block(1, "not-published", `${ledger.target} is not recorded as published`);

    return;
  }

  for (const name of packageNames) {
    const version = published.packages[name]?.version;

    if (version !== ledger.target) {
      block(1, "wrong-version", `${name} is recorded at ${version}, the target ${ledger.target}`);
    }
    if (baseline && baseline.packages[name]?.integrity === published.packages[name]?.integrity) {
      block(1, "baseline-as-rc", `${name}: the RC tuple is the baseline artifact`);
    }
  }

  if (candidate) {
    const changed = git.changedPaths(candidate.sha, published.publishSha);

    if (changed === null || !onlyVersioning(changed, candidate.sha, published.publishSha, git)) {
      block(1, "published-other-code", `${published.publishSha} is not the authorized candidate`);
    }
  }

  checkTupleBinding("rc", published, packageNames, git, block);

  const lookups = await checkTupleOnRegistry(
    "rc",
    published,
    packageNames,
    facts.readRegistry,
    block,
  );

  for (const [name, lookup] of lookups) {
    if (lookup.status !== "found") continue;

    const version = published.packages[name]!.version;

    if (lookup.versions[version]?.dist?.provenance !== true) {
      block(2, "rc-provenance", `${name}@${version} has no provenance attestation`);
    }
    if (lookup.distTags["next"] !== version) {
      block(3, "dist-tag-drift", `${name} next is ${lookup.distTags["next"] ?? "absent"}`);
    }
    if (lookup.distTags["latest"] === version) {
      block(3, "dist-tag-drift", `${name} latest moved to the prerelease ${version}`);
    }
  }
}

export async function assessRc(facts: RcFacts): Promise<RcAssessment> {
  const blockers: RcBlocker[] = [];
  const block: Block = (rank, id, reason) => blockers.push({ rank, id, reason });
  const invalid = ledgerProblems(facts.ledger, facts.packageNames);

  if (invalid.length > 0) {
    for (const problem of invalid) block(0, "invalid-ledger", problem);

    return { phase: facts.phase, verdict: "NO-GO", blockers, accepted: [] };
  }

  const ledger = facts.ledger as EvidenceLedger;

  await (facts.phase === "pre"
    ? assessPre(facts, ledger, block)
    : assessPost(facts, ledger, block));

  for (const spec of RC_REQUIREMENTS) {
    if (spec.gate !== "blocker" || spec.phase !== facts.phase) continue;

    const row = ledger.rows.find(({ id }) => id === spec.id)!;

    await checkRow(row, spec, facts, ledger, (reason) => block(10 + spec.rank, spec.id, reason));
  }

  blockers.sort((a, b) => a.rank - b.rank);

  return {
    phase: facts.phase,
    verdict: blockers.length === 0 ? "GO" : "NO-GO",
    blockers,
    accepted: RC_REQUIREMENTS.filter(({ gate }) => gate === "accepted").map(({ id }) => {
      const row = ledger.rows.find((candidate) => candidate.id === id)!;

      return { id, status: row.status, note: row.note };
    }),
  };
}
