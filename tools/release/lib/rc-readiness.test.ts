import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RC_REQUIREMENTS } from "./rc-catalog.ts";
import type { HostedProofSpec, RcRequirement } from "./rc-catalog.ts";
import { assessRc, candidateIdentity, ledgerProblems, onlyVersioning } from "./rc-readiness.ts";
import type {
  EvidenceLedger,
  EvidenceRow,
  GitFacts,
  HostedReader,
  HostedRun,
  RcFacts,
} from "./rc-readiness.ts";
import { parseHostedRun } from "./rc-sources.ts";
import type { RegistryReader } from "./registry.ts";

const REPOSITORY = "Andersseen/Strata";
const NAMES = ["@strata-sc/core", "@strata-sc/analog", "@strata-sc/server-components"];
const sha = (seed: string): string => createHash("sha1").update(seed).digest("hex");
const CANDIDATE = sha("candidate");
const DOCS_ONLY = sha("docs-only");
const CODE_CHANGE = sha("code-change");
const VERSIONED = sha("versioned");
const HARNESS = sha("harness");
const RC_HARNESS = sha("rc-harness");
const OLD_PIPELINE = sha("old-pipeline");
const integrity = (seed: string): string =>
  `sha512-${createHash("sha512").update(seed).digest("base64")}`;

const manifest = (version: string): string =>
  JSON.stringify({ name: "x", version, type: "module" });
const lock = "lockfile v9";
const baselineTuple = {
  harnessSha: HARNESS,
  frozenId: "baseline-id",
  packages: Object.fromEntries(
    NAMES.map((name) => [name, { version: "0.17.0", integrity: integrity(`${name}-base`) }]),
  ),
};
const publishedTuple = {
  harnessSha: RC_HARNESS,
  frozenId: "rc-id",
  publishSha: VERSIONED,
  packages: Object.fromEntries(
    NAMES.map((name) => [name, { version: "1.0.0-rc.0", integrity: integrity(`${name}-rc`) }]),
  ),
};
const frozen = (tuple: typeof baselineTuple): string =>
  JSON.stringify({ id: tuple.frozenId, strata: tuple.packages });

/** Each commit's files; `changedPaths` compares whole commits, as git does. */
const COMMITS: Record<string, Record<string, string>> = {
  [CANDIDATE]: {
    "pnpm-lock.yaml": lock,
    ".changeset/config.json": "{}",
    "package.json": "{}",
    "pnpm-workspace.yaml": "packages: []",
    "packages/core/package.json": manifest("0.17.0"),
    "packages/analog/package.json": manifest("0.17.0"),
    "packages/server-components/package.json": manifest("0.17.0"),
    "packages/core/src.ts": "code",
  },
};

COMMITS[DOCS_ONLY] = {
  ...COMMITS[CANDIDATE]!,
  "docs/STATE.md": "new",
  "tools/release/rc-evidence.json": "x",
};
COMMITS[CODE_CHANGE] = { ...COMMITS[CANDIDATE]!, "packages/core/src.ts": "changed" };
COMMITS[VERSIONED] = {
  ...COMMITS[CANDIDATE]!,
  "packages/core/package.json": manifest("1.0.0-rc.0"),
  "packages/analog/package.json": manifest("1.0.0-rc.0"),
  "packages/server-components/package.json": manifest("1.0.0-rc.0"),
  "packages/core/CHANGELOG.md": "rc",
  ".changeset/rc-entry.md": "consumed",
};
COMMITS[HARNESS] = {
  ...COMMITS[CANDIDATE]!,
  "tests/full-stack-candidate/candidate.json": frozen(baselineTuple),
};
COMMITS[RC_HARNESS] = {
  ...COMMITS[VERSIONED],
  "tests/full-stack-candidate/candidate.json": frozen(publishedTuple),
};
COMMITS[OLD_PIPELINE] = { ...COMMITS[CANDIDATE]!, "tools/release/lib/dist-tags.ts": "older" };

const git = (head = CANDIDATE): GitFacts => ({
  head: () => head,
  read: (commit, path) => COMMITS[commit]?.[path] ?? null,
  tree: (commit) =>
    COMMITS[commit] ? sha(`tree-${COMMITS[commit]["packages/core/src.ts"]}`) : null,
  changedPaths: (from, to) => {
    const a = COMMITS[from];
    const b = COMMITS[to];

    if (!a || !b) return null;

    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (path) => a[path] !== b[path],
    );
  },
});

const packages = NAMES.map((name) => ({ name, dir: `packages/${name.split("/")[1]}` }));
const identity = candidateIdentity(CANDIDATE, git(), packages)!;

const headFor = (spec: RcRequirement): string => {
  if (spec.id === "rc-publication") return VERSIONED;
  if (spec.artifact === "baseline-registry") return HARNESS;
  if (spec.artifact === "rc-registry") return RC_HARNESS;

  return CANDIDATE;
};

const runIdOf = (spec: RcRequirement): number => 1000 + RC_REQUIREMENTS.indexOf(spec);

function runFor(spec: RcRequirement): HostedRun {
  const proof = spec.proof as HostedProofSpec;

  return {
    id: runIdOf(spec),
    repository: REPOSITORY,
    headRepository: REPOSITORY,
    path: proof.workflow,
    event: proof.events[0]!,
    headBranch: "main",
    headSha: headFor(spec),
    title: `Qualify ${proof.titleIncludes ?? ""}`,
    status: "completed",
    conclusion: "success",
    jobs: proof.jobs.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
      steps: (proof.steps ?? []).map((step) => ({ name: step, conclusion: "success" })),
    })),
  };
}

const passingRow = (spec: RcRequirement): EvidenceRow => ({
  id: spec.id,
  gate: spec.gate,
  artifact: spec.artifact,
  status: spec.proof.kind === "none" ? "NOT RUN" : "PASS",
  proof:
    spec.proof.kind === "hosted-run"
      ? { kind: "hosted-run", runId: runIdOf(spec) }
      : spec.proof.kind === "maintainer-decision"
        ? { kind: "maintainer-decision", pullRequest: 7 }
        : null,
  note: "",
});

const goodLedger = (): EvidenceLedger => ({
  schema: 2,
  target: "1.0.0-rc.0",
  candidate: identity,
  baseline: baselineTuple,
  published: publishedTuple,
  rows: RC_REQUIREMENTS.map(passingRow),
});

const withRow = (
  ledger: EvidenceLedger,
  id: string,
  patch: Partial<EvidenceRow> | ((row: EvidenceRow) => EvidenceRow),
): EvidenceLedger => ({
  ...ledger,
  rows: ledger.rows.map((row) =>
    row.id !== id ? row : typeof patch === "function" ? patch(row) : { ...row, ...patch },
  ),
});

const hosted = (override: (run: HostedRun) => HostedRun = (run) => run): HostedReader => ({
  run: (runId) => {
    const spec = RC_REQUIREMENTS.find((candidate) => runIdOf(candidate) === runId);

    return spec
      ? Promise.resolve(override(runFor(spec)))
      : Promise.reject(new Error("no such run"));
  },
  pullRequest: () => Promise.resolve({ merged: true, mergedBy: "Andersseen", mergeSha: DOCS_ONLY }),
});

const reader =
  (
    tags: Record<string, string> = { latest: "0.17.0", next: "0.17.0" },
    overrides: { integrity?: string; provenance?: boolean } = {},
  ): RegistryReader =>
  (name, version) =>
    Promise.resolve({
      status: "found",
      name,
      versions: {
        [version]: {
          dependencies: {},
          dist: {
            tarball: "https://registry.npmjs.org/x.tgz",
            integrity:
              overrides.integrity ??
              (version === "0.17.0" ? integrity(`${name}-base`) : integrity(`${name}-rc`)),
            provenance: overrides.provenance ?? true,
          },
        },
      },
      distTags: tags,
    });

const rcTags = { latest: "0.17.0", next: "1.0.0-rc.0", rc: "1.0.0-rc.0" };

const facts = (overrides: Partial<RcFacts> = {}): RcFacts => ({
  ledger: goodLedger(),
  phase: "pre",
  repository: REPOSITORY,
  maintainer: "Andersseen",
  packageNames: NAMES,
  manifestVersions: Object.fromEntries(NAMES.map((name) => [name, "0.17.0"])),
  pendingChangesets: 0,
  git: git(),
  hosted: hosted(),
  readRegistry: reader(),
  ...overrides,
});

const postFacts = (overrides: Partial<RcFacts> = {}): RcFacts =>
  facts({ phase: "post", readRegistry: reader(rcTags), ...overrides });

const blockerIds = async (input: RcFacts): Promise<string[]> =>
  (await assessRc(input)).blockers.map(({ id }) => id);

describe("the qualified path", () => {
  it("authorizes a candidate whose proofs all read back", async () => {
    await expect(assessRc(facts())).resolves.toMatchObject({ verdict: "GO", blockers: [] });
  });

  it("qualifies the published tuple only in the post phase", async () => {
    await expect(assessRc(postFacts())).resolves.toMatchObject({ verdict: "GO", blockers: [] });
  });

  it("keeps accepted risks visible, and they never block", async () => {
    const { accepted } = await assessRc(facts());

    expect(accepted.map(({ id }) => id)).toEqual([
      "real-application",
      "persistent-node",
      "cloudflare-cold-start-memory",
      "issue-117-transitions",
    ]);
  });
});

describe("the catalog", () => {
  it("has unique ids and proof for every blocker", () => {
    expect(new Set(RC_REQUIREMENTS.map(({ id }) => id)).size).toBe(RC_REQUIREMENTS.length);
    for (const spec of RC_REQUIREMENTS.filter(({ gate }) => gate === "blocker")) {
      expect(spec.proof.kind, spec.id).not.toBe("none");
    }
  });

  it("never lets a pre row prove the published RC, or a post row the baseline", () => {
    for (const spec of RC_REQUIREMENTS) {
      if (spec.phase === "pre") expect(spec.artifact, spec.id).not.toBe("rc-registry");
      else expect(spec.artifact, spec.id).toBe("rc-registry");
    }
  });
});

describe("ledger structure", () => {
  const problems = (ledger: unknown): string[] => ledgerProblems(ledger, NAMES);

  it("accepts the complete catalog", () => {
    expect(problems(goodLedger())).toEqual([]);
  });

  it("rejects an omitted requirement", () => {
    const ledger = goodLedger();

    expect(problems({ ...ledger, rows: ledger.rows.slice(1) })).toEqual([
      "requirement ci-verify is missing from the ledger",
    ]);
  });

  it("rejects the audit case: one arbitrary accepted row", async () => {
    const ledger = {
      ...goodLedger(),
      rows: [
        {
          id: "anything",
          gate: "accepted",
          artifact: "none",
          status: "NOT RUN",
          proof: null,
          note: "",
        },
      ],
    };

    expect(problems(ledger)).toContain("unknown requirement anything");

    await expect(assessRc(facts({ ledger }))).resolves.toMatchObject({ verdict: "NO-GO" });
  });

  it("rejects duplicate and unknown ids", () => {
    const ledger = goodLedger();

    expect(problems({ ...ledger, rows: [...ledger.rows, ledger.rows[0]] })).toContain(
      "duplicate row ci-verify",
    );
    expect(
      problems({ ...ledger, rows: [...ledger.rows, { ...ledger.rows[0], id: "made-up" }] }),
    ).toContain("unknown requirement made-up");
  });

  it("rejects an invalid status", () => {
    const ledger = withRow(goodLedger(), "ci-verify", { status: "SKIPPED" as "PASS" });

    expect(problems(ledger)).toContain("ci-verify has an invalid status SKIPPED");
  });

  it("rejects a blocker degraded to accepted", () => {
    const ledger = withRow(goodLedger(), "ssr-duplicate-install", { gate: "accepted" });

    expect(problems(ledger)).toContain(
      "ssr-duplicate-install is a blocker requirement, the ledger says accepted",
    );
  });

  it("rejects a PASS without proof", () => {
    const ledger = withRow(goodLedger(), "ci-verify", { proof: null });

    expect(problems(ledger)).toContain("ci-verify claims PASS without proof");
  });

  it("rejects a hand-written link in place of a run", () => {
    const ledger = withRow(goodLedger(), "ci-verify", (row) => ({
      ...row,
      proof: { kind: "url", link: "https://example.test/green" } as never,
    }));

    expect(problems(ledger)).toContain("ci-verify needs hosted-run proof, not url");
  });

  it("rejects a PASS for what the repository cannot prove", () => {
    const ledger = withRow(goodLedger(), "real-application", { status: "PASS" });

    expect(problems(ledger)).toContain("real-application cannot be proven here, so it cannot PASS");
  });

  it("rejects source-packed evidence relabelled as registry evidence", () => {
    const ledger = withRow(goodLedger(), "node-production-source", {
      artifact: "baseline-registry",
    });

    expect(problems(ledger)).toContain(
      "node-production-source proves source-packed, the ledger says baseline-registry",
    );
  });

  it("rejects fields the schema does not know", () => {
    const ledger = withRow(goodLedger(), "ci-verify", (row) => ({ ...row, waived: true }) as never);

    expect(problems(ledger)).toContain("ci-verify has unknown fields: waived");
  });

  it("rejects an abbreviated SHA, a non-RC target and a tuple without integrity", () => {
    const ledger = goodLedger();

    expect(problems({ ...ledger, candidate: { ...identity, sha: "abc123" } })).toContain(
      "candidate.sha is not a full commit SHA",
    );
    expect(problems({ ...ledger, target: "1.0.0" })).toContain(
      "ledger target is not a 1.0.0-rc.N version",
    );

    const packagesWithout = {
      ...baselineTuple.packages,
      [NAMES[0]!]: { version: "0.17.0", integrity: "unknown" },
    };

    expect(
      problems({ ...ledger, baseline: { ...baselineTuple, packages: packagesWithout } }),
    ).toContain("baseline has no sha512 integrity of @strata-sc/core");
  });

  it("makes a NO-GO of any invalid ledger, even with every other fact good", async () => {
    await expect(blockerIds(facts({ ledger: { schema: 1, rows: [] } }))).resolves.toContain(
      "invalid-ledger",
    );
  });
});

describe("hosted proof", () => {
  const onRun = (patch: Partial<HostedRun>, id = "ci-verify") =>
    facts({
      hosted: hosted((run) =>
        run.id === runIdOf(RC_REQUIREMENTS.find((spec) => spec.id === id)!)
          ? { ...run, ...patch }
          : run,
      ),
    });

  it.each(["failure", "cancelled", "skipped", "timed_out"])(
    "refuses a job that concluded %s",
    async (conclusion) => {
      const input = facts({
        hosted: hosted((run) =>
          run.jobs[0]?.name === "Verify" ? { ...run, jobs: [{ ...run.jobs[0], conclusion }] } : run,
        ),
      });

      await expect(blockerIds(input)).resolves.toContain("ci-verify");
    },
  );

  it("refuses a job still in progress", async () => {
    const input = facts({
      hosted: hosted((run) =>
        run.jobs[0]?.name === "Verify"
          ? { ...run, jobs: [{ ...run.jobs[0], status: "in_progress", conclusion: null }] }
          : run,
      ),
    });

    await expect(blockerIds(input)).resolves.toContain("ci-verify");
  });

  it("refuses a run that does not contain the job", async () => {
    await expect(blockerIds(onRun({ jobs: [] }))).resolves.toContain("ci-verify");
  });

  it("refuses the wrong workflow, event, branch and repository", async () => {
    await expect(blockerIds(onRun({ path: ".github/workflows/other.yml" }))).resolves.toContain(
      "ci-verify",
    );
    await expect(blockerIds(onRun({ event: "pull_request" }))).resolves.toContain("ci-verify");
    await expect(blockerIds(onRun({ headBranch: "topic" }))).resolves.toContain("ci-verify");
    await expect(blockerIds(onRun({ headRepository: "fork/Strata" }))).resolves.toContain(
      "ci-verify",
    );
  });

  it("refuses a run of another candidate", async () => {
    await expect(blockerIds(onRun({ headSha: CODE_CHANGE }))).resolves.toContain("ci-verify");
  });

  it("refuses a commit it cannot read", async () => {
    await expect(blockerIds(onRun({ headSha: sha("unknown") }))).resolves.toContain("ci-verify");
  });

  it("refuses a Release run that only opened a Version PR", async () => {
    const input = facts({
      hosted: hosted((run) =>
        run.path.endsWith("release.yml")
          ? {
              ...run,
              jobs: run.jobs.map((job) => ({
                ...job,
                steps: job.steps.map((step) =>
                  step.name === "Align npm dist-tags" ? { ...step, conclusion: "skipped" } : step,
                ),
              })),
            }
          : run,
      ),
    });

    await expect(blockerIds(input)).resolves.toContain("release-pipeline-observed");
  });

  it("refuses a performance run that skipped the three-island profile", async () => {
    const input = facts({
      hosted: hosted((run) =>
        run.jobs[0]?.name.startsWith("Full-stack performance baseline")
          ? {
              ...run,
              jobs: run.jobs.map((job) => ({
                ...job,
                steps: job.steps.filter((step) => step.name !== "Measure three islands"),
              })),
            }
          : run,
      ),
    });

    await expect(blockerIds(input)).resolves.toContain("island-interaction");
  });

  it("refuses a deployment of the wrong source", async () => {
    const input = facts({
      hosted: hosted((run) =>
        run.title.includes("(packed)") ? { ...run, title: "Qualify (registry)" } : run,
      ),
    });

    await expect(blockerIds(input)).resolves.toContain("deployed-source-packed");
  });

  it("is a blocker, not a pass, when GitHub cannot answer", async () => {
    const down: HostedReader = {
      run: () => Promise.reject(new Error("503")),
      pullRequest: () => Promise.reject(new Error("503")),
    };

    await expect(assessRc(facts({ hosted: down }))).resolves.toMatchObject({ verdict: "NO-GO" });
  });

  it("needs the maintainer's merge for a maintainer decision", async () => {
    const reviewed = (mergedBy: string | null, merged = true): HostedReader => ({
      ...hosted(),
      pullRequest: () => Promise.resolve({ merged, mergedBy, mergeSha: DOCS_ONLY }),
    });

    await expect(blockerIds(facts({ hosted: reviewed("someone-else") }))).resolves.toContain(
      "support-contract-review",
    );
    await expect(blockerIds(facts({ hosted: reviewed(null, false) }))).resolves.toContain(
      "support-contract-review",
    );
  });

  it("does not read a malformed API body as a run", () => {
    expect(() => parseHostedRun({ message: "Not Found" }, {})).toThrow(/not a workflow run/);
    expect(
      parseHostedRun(
        { id: 1, repository: { full_name: REPOSITORY }, conclusion: null },
        { jobs: [{ name: "Verify", status: "completed", conclusion: "success" }] },
      ).jobs[0],
    ).toMatchObject({ name: "Verify", steps: [] });
  });
});

describe("candidate identity", () => {
  it("binds the recorded tree, lock, configuration and versions to the commit", async () => {
    for (const patch of [
      { sourceTree: sha("other-tree") },
      { lockDigest: "0".repeat(64) },
      { configDigest: "1".repeat(64) },
      { versions: { ...identity.versions, "@strata-sc/core": "0.16.0" } },
    ]) {
      const ledger = { ...goodLedger(), candidate: { ...identity, ...patch } };

      await expect(blockerIds(facts({ ledger }))).resolves.toContain("candidate-identity");
    }
  });

  it("applies a ledger to documentation-only commits after the candidate", async () => {
    await expect(blockerIds(facts({ git: git(DOCS_ONLY) }))).resolves.toEqual([]);
  });

  it("refuses an old ledger on new code", async () => {
    await expect(blockerIds(facts({ git: git(CODE_CHANGE) }))).resolves.toContain("stale-ledger");
  });

  it("does not trust a changed package README as documentation", () => {
    const paths = ["packages/core/README.md"];

    expect(onlyVersioning(paths, CANDIDATE, CANDIDATE, git())).toBe(false);
  });

  it("refuses evidence reused across a test or tooling change", async () => {
    const commit = sha("tooling");

    COMMITS[commit] = { ...COMMITS[CANDIDATE]!, "tools/performance/lib/smoke.ts": "x" };

    await expect(blockerIds(facts({ git: git(commit) }))).resolves.toContain("stale-ledger");
  });

  it("names unreleased source, and keeps a pending plan out of a published baseline", async () => {
    await expect(blockerIds(facts({ pendingChangesets: 1 }))).resolves.toContain(
      "unreleased-source",
    );
  });
});

describe("publishing the candidate", () => {
  const publishing = (overrides: Partial<RcFacts> = {}): RcFacts =>
    facts({
      publishing: true,
      git: git(VERSIONED),
      manifestVersions: Object.fromEntries(NAMES.map((name) => [name, "1.0.0-rc.0"])),
      ...overrides,
    });

  it("allows exactly the versioning diff", async () => {
    await expect(blockerIds(publishing())).resolves.toEqual([]);
  });

  it("refuses that diff unless it is the publishing check", async () => {
    await expect(blockerIds(facts({ git: git(VERSIONED) }))).resolves.toContain("stale-ledger");
  });

  it("refuses a dependency smuggled into a version bump", async () => {
    const commit = sha("smuggled");

    COMMITS[commit] = {
      ...COMMITS[VERSIONED]!,
      "packages/core/package.json": JSON.stringify({
        ...(JSON.parse(manifest("1.0.0-rc.0")) as object),
        dependencies: { "left-pad": "1.0.0" },
      }),
    };

    await expect(blockerIds(publishing({ git: git(commit) }))).resolves.toContain("stale-ledger");
  });

  it("refuses a manifest that is not the target", async () => {
    await expect(
      blockerIds(
        publishing({
          manifestVersions: Object.fromEntries(NAMES.map((name) => [name, "1.0.0-rc.1"])),
        }),
      ),
    ).resolves.toContain("wrong-version");
  });

  it("refuses a release pipeline changed since it was observed", async () => {
    const input = facts({
      hosted: hosted((run) =>
        run.path.endsWith("release.yml") ? { ...run, headSha: OLD_PIPELINE } : run,
      ),
    });

    await expect(blockerIds(input)).resolves.toContain("release-pipeline-observed");
  });
});

describe("the observed pipeline", () => {
  it("survives entering the RC line and recording evidence", async () => {
    const before = sha("before-entry");

    COMMITS[before] = {
      ...COMMITS[CANDIDATE]!,
      ".changeset/config.json": '{"fixed":[]}',
      "tools/release/rc-evidence.json": "earlier",
    };

    const input = facts({
      hosted: hosted((run) =>
        run.path.endsWith("release.yml") ? { ...run, headSha: before } : run,
      ),
    });

    await expect(blockerIds(input)).resolves.not.toContain("release-pipeline-observed");
  });
});

describe("tuples", () => {
  it("does not need a published RC to authorize the first one", async () => {
    const ledger = { ...goodLedger(), published: null };

    await expect(assessRc(facts({ ledger }))).resolves.toMatchObject({ verdict: "GO" });
  });

  it("refuses a post phase without the published tuple", async () => {
    const ledger = { ...goodLedger(), published: null };

    await expect(blockerIds(postFacts({ ledger }))).resolves.toContain("not-published");
  });

  it("refuses post-publication rows that are missing", async () => {
    const ledger = withRow(goodLedger(), "rc-deployed", { status: "NOT RUN", proof: null });

    await expect(blockerIds(postFacts({ ledger }))).resolves.toContain("rc-deployed");
  });

  it("refuses the 0.x baseline presented as the RC", async () => {
    const ledger = {
      ...goodLedger(),
      published: { ...publishedTuple, packages: baselineTuple.packages },
    };

    const ids = await blockerIds(postFacts({ ledger }));

    expect(ids).toContain("baseline-as-rc");
    expect(ids).toContain("wrong-version");
  });

  it("refuses a registry row obtained on the source-packed commit", async () => {
    // Mixed evidence: the run exists and is green, but it is not the harness of this tuple.
    const input = postFacts({
      hosted: hosted((run) =>
        run.title.includes("(registry)") ? { ...run, headSha: CANDIDATE } : run,
      ),
    });

    await expect(blockerIds(input)).resolves.toContain("rc-deployed");
  });

  it("refuses a frozen candidate that is not the ledger's tuple", async () => {
    const commit = sha("other-frozen");

    COMMITS[commit] = {
      ...COMMITS[CANDIDATE]!,
      "tests/full-stack-candidate/candidate.json": frozen({
        ...baselineTuple,
        packages: {
          ...baselineTuple.packages,
          [NAMES[0]!]: { version: "0.17.0", integrity: integrity("other") },
        },
      }),
    };

    const ledger = { ...goodLedger(), baseline: { ...baselineTuple, harnessSha: commit } };

    await expect(blockerIds(facts({ ledger }))).resolves.toContain("baseline-frozen-candidate");
  });

  it("refuses an artifact npm does not serve with the recorded integrity", async () => {
    const readRegistry = reader(undefined, { integrity: integrity("tampered") });

    await expect(blockerIds(facts({ readRegistry }))).resolves.toContain("baseline-integrity");
  });

  it("refuses an unpublished baseline, and an unreadable registry", async () => {
    const missing: RegistryReader = () => Promise.resolve({ status: "missing" });
    const down: RegistryReader = () => Promise.reject(new Error("registry 503"));

    await expect(blockerIds(facts({ readRegistry: missing }))).resolves.toContain(
      "baseline-unpublished",
    );
    await expect(blockerIds(facts({ readRegistry: down }))).resolves.toContain(
      "registry-unreadable",
    );
  });

  it("refuses dist-tag drift on the baseline", async () => {
    const readRegistry = reader({ latest: "0.17.0", next: "0.16.0" });

    await expect(blockerIds(facts({ readRegistry }))).resolves.toContain("dist-tag-drift");
  });

  it("refuses a published RC without provenance", async () => {
    const readRegistry = reader(rcTags, { provenance: false });

    await expect(blockerIds(postFacts({ readRegistry }))).resolves.toContain("rc-provenance");
  });

  it("refuses a prerelease on latest, and next left behind", async () => {
    await expect(
      blockerIds(postFacts({ readRegistry: reader({ ...rcTags, latest: "1.0.0-rc.0" }) })),
    ).resolves.toContain("dist-tag-drift");
    await expect(
      blockerIds(postFacts({ readRegistry: reader({ ...rcTags, next: "0.17.0" }) })),
    ).resolves.toContain("dist-tag-drift");
  });

  it("refuses a publication of code other than the authorized candidate", async () => {
    const ledger = {
      ...goodLedger(),
      published: { ...publishedTuple, publishSha: CODE_CHANGE },
    };

    await expect(blockerIds(postFacts({ ledger }))).resolves.toContain("published-other-code");
  });
});

describe("a failed requirement stays failed", () => {
  it.each(["PARTIAL", "FAIL", "NOT RUN"] as const)("%s blocks", async (status) => {
    const ledger = withRow(goodLedger(), "ssr-duplicate-install", { status, proof: null });

    await expect(blockerIds(facts({ ledger }))).resolves.toContain("ssr-duplicate-install");
  });

  it("ranks identity before evidence", async () => {
    const ledger = withRow(goodLedger(), "ci-verify", { status: "FAIL", proof: null });
    const { blockers } = await assessRc(facts({ ledger, git: git(CODE_CHANGE) }));

    expect(blockers[0]!.id).toBe("stale-ledger");
  });
});
