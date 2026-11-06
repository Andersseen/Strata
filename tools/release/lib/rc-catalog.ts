/**
 * What a Strata release candidate must prove (docs/specs/004-first-release-candidate.md). The catalog
 * is code, not ledger data: tools/release/rc-evidence.json records results against these ids and can
 * neither drop a requirement nor reclassify one.
 *
 * Two phases, so the first RC is not asked to exist before it is published:
 *
 *   pre    authorizes publication: the source-packed candidate, plus the published 0.x baseline that
 *          proves the pipeline and the tooling around it.
 *   post   qualifies the exact artifacts on npm. Evidence from the 0.x baseline never counts here: a
 *          row is bound to one tuple, and the two phases hold different ones.
 */

export type RcPhase = "pre" | "post";
export type RcGate = "blocker" | "accepted";
/** What was under test. A source-packed result says nothing about what npm serves, and vice versa. */
export type RcArtifact = "source-packed" | "baseline-registry" | "rc-registry" | "none";
/**
 * What the proving run must be tied to.
 *
 *   candidate  the candidate SHA, or a commit that differs from it by documentation only.
 *   pipeline   a commit whose RELEASE_PIPELINE_PATHS are identical to the candidate's.
 *   tuple      the harness SHA recorded with the tuple named by `artifact`.
 */
export type RcBinding = "candidate" | "pipeline" | "tuple";

export interface HostedProofSpec {
  readonly kind: "hosted-run";
  readonly workflow: string;
  readonly events: readonly string[];
  /** Exact job names; each must have concluded `success`. */
  readonly jobs: readonly string[];
  /** Exact step names in those jobs; each must have concluded `success`, not `skipped`. */
  readonly steps?: readonly string[];
  /** The run's title must contain this: how a dispatch input becomes visible through the API. */
  readonly titleIncludes?: string;
}

export type ProofSpec =
  | HostedProofSpec
  /** A merged pull request of the maintainer. */
  | { readonly kind: "maintainer-decision" }
  /** Nothing in this repository can prove it, so the ledger can never claim PASS. */
  | { readonly kind: "none" };

export interface RcRequirement {
  readonly id: string;
  readonly requirement: string;
  readonly gate: RcGate;
  readonly phase: RcPhase;
  /** Lower ranks first in the blocker list. */
  readonly rank: number;
  readonly artifact: RcArtifact;
  readonly binding: RcBinding;
  readonly proof: ProofSpec;
}

const CI = ".github/workflows/ci.yml";
const EXTENDED = ".github/workflows/extended.yml";
const RELEASE = ".github/workflows/release.yml";
const DEPLOYED = ".github/workflows/full-stack-deployed-cloudflare.yml";
const EXTENDED_EVENTS = ["workflow_dispatch", "schedule"] as const;

const ci = (job: string): HostedProofSpec => ({
  kind: "hosted-run",
  workflow: CI,
  events: ["push"],
  jobs: [job],
});
const extended = (job: string, steps?: readonly string[]): HostedProofSpec => ({
  kind: "hosted-run",
  workflow: EXTENDED,
  events: EXTENDED_EVENTS,
  jobs: [job],
  ...(steps ? { steps } : {}),
});
const deployed = (source: string): HostedProofSpec => ({
  kind: "hosted-run",
  workflow: DEPLOYED,
  events: ["workflow_dispatch"],
  jobs: ["Deploy and qualify the full-stack app on Cloudflare Pages"],
  titleIncludes: `(${source})`,
});
const release: HostedProofSpec = {
  kind: "hosted-run",
  workflow: RELEASE,
  events: ["workflow_run"],
  jobs: ["Version or publish"],
  // Skipped on a run that only opened a Version PR: only a real publish passes.
  steps: [
    "Version PR or publish to npm",
    "Align npm dist-tags",
    "Verify npm registry, tags and GitHub Releases",
  ],
};

const FROZEN_JOB = "Frozen release candidate (npm ci of the captured tree; Node + local workerd)";
const NODE_FROZEN_JOB =
  "Node production process (frozen candidate, Nitro node-server, hosted Linux)";

export const RC_REQUIREMENTS: readonly RcRequirement[] = [
  {
    id: "ci-verify",
    requirement: "Aggregate CI Verify on the candidate's main push",
    gate: "blocker",
    phase: "pre",
    rank: 1,
    artifact: "source-packed",
    binding: "candidate",
    proof: ci("Verify"),
  },
  {
    id: "release-pipeline-observed",
    requirement: "One real publish through the current release pipeline, without manual repair",
    gate: "blocker",
    phase: "pre",
    rank: 2,
    artifact: "none",
    binding: "pipeline",
    proof: release,
  },
  {
    id: "baseline-frozen",
    requirement: "npm ci of the frozen published baseline tuple",
    gate: "blocker",
    phase: "pre",
    rank: 3,
    artifact: "baseline-registry",
    binding: "tuple",
    proof: extended(FROZEN_JOB),
  },
  {
    id: "baseline-deployed",
    requirement: "Published baseline tuple deployed to Cloudflare Pages",
    gate: "blocker",
    phase: "pre",
    rank: 4,
    artifact: "baseline-registry",
    binding: "tuple",
    proof: deployed("registry"),
  },
  {
    id: "baseline-upgrade-rollback",
    requirement: "Deployed upgrade and retained-artifact rollback onto the baseline tuple",
    gate: "blocker",
    phase: "pre",
    rank: 5,
    artifact: "baseline-registry",
    binding: "tuple",
    proof: deployed("upgrade-rollback"),
  },
  {
    id: "island-interaction",
    requirement: "One and three islands: one effect per interaction, replay included, four arms",
    gate: "blocker",
    phase: "pre",
    rank: 6,
    artifact: "source-packed",
    binding: "candidate",
    proof: extended("Full-stack performance baseline (Node + local workerd)", [
      "Measure one island (PR #86 baseline)",
      "Measure three islands",
    ]),
  },
  {
    id: "performance-scaling",
    requirement: "Controller scaling profile and browser size budgets",
    gate: "blocker",
    phase: "pre",
    rank: 7,
    artifact: "source-packed",
    binding: "candidate",
    proof: extended("Full-stack performance, controller scaling profile (Node + local workerd)"),
  },
  {
    id: "ssr-duplicate-install",
    requirement: "SSR contract with a duplicated package installation",
    gate: "blocker",
    phase: "pre",
    rank: 8,
    artifact: "source-packed",
    binding: "candidate",
    proof: extended("SSR contract with a duplicated package installation (Node + local workerd)"),
  },
  {
    id: "node-production-source",
    requirement: "Node production process on hosted Linux, source-packed candidate",
    gate: "blocker",
    phase: "pre",
    rank: 9,
    artifact: "source-packed",
    binding: "candidate",
    proof: extended(
      "Node production process (source-packed candidate, Nitro node-server, hosted Linux)",
    ),
  },
  {
    id: "adversarial-security",
    requirement: "Source-mutated adversarial security qualification",
    gate: "blocker",
    phase: "pre",
    rank: 10,
    artifact: "source-packed",
    binding: "candidate",
    proof: extended("Full-stack source-mutated security qualification (Node + workerd + Chromium)"),
  },
  {
    id: "deployed-source-packed",
    requirement: "Source-packed candidate deployed to Cloudflare Pages",
    gate: "blocker",
    phase: "pre",
    rank: 11,
    artifact: "source-packed",
    binding: "candidate",
    proof: deployed("packed"),
  },
  {
    id: "prerelease-rehearsal",
    requirement: "Non-publishing Changesets prerelease rehearsal",
    gate: "blocker",
    phase: "pre",
    rank: 12,
    artifact: "none",
    binding: "candidate",
    proof: extended("RC readiness report and non-publishing prerelease rehearsal"),
  },
  {
    id: "support-contract-review",
    requirement: "Maintainer review of the RC support contract",
    gate: "blocker",
    phase: "pre",
    rank: 13,
    artifact: "none",
    binding: "candidate",
    proof: { kind: "maintainer-decision" },
  },
  {
    id: "rc-publication",
    requirement: "The Release run that published the RC tuple",
    gate: "blocker",
    phase: "post",
    rank: 1,
    artifact: "rc-registry",
    binding: "tuple",
    proof: release,
  },
  {
    id: "rc-frozen",
    requirement: "npm ci of the frozen RC tuple",
    gate: "blocker",
    phase: "post",
    rank: 2,
    artifact: "rc-registry",
    binding: "tuple",
    proof: extended(FROZEN_JOB),
  },
  {
    id: "rc-node-production",
    requirement: "Node production process on hosted Linux, frozen RC tuple",
    gate: "blocker",
    phase: "post",
    rank: 3,
    artifact: "rc-registry",
    binding: "tuple",
    proof: extended(NODE_FROZEN_JOB),
  },
  {
    id: "rc-deployed",
    requirement: "RC tuple from npm deployed to Cloudflare Pages",
    gate: "blocker",
    phase: "post",
    rank: 4,
    artifact: "rc-registry",
    binding: "tuple",
    proof: deployed("registry"),
  },
  {
    id: "rc-upgrade-rollback",
    requirement: "Deployed upgrade to the RC and retained-artifact rollback",
    gate: "blocker",
    phase: "post",
    rank: 5,
    artifact: "rc-registry",
    binding: "tuple",
    proof: deployed("upgrade-rollback"),
  },
  {
    id: "real-application",
    requirement: "A real application on the production path",
    gate: "accepted",
    phase: "pre",
    rank: 1,
    artifact: "none",
    binding: "candidate",
    proof: { kind: "none" },
  },
  {
    id: "persistent-node",
    requirement: "A persistent Node deployment",
    gate: "accepted",
    phase: "pre",
    rank: 2,
    artifact: "none",
    binding: "candidate",
    proof: { kind: "none" },
  },
  {
    id: "cloudflare-cold-start-memory",
    requirement: "Cloudflare isolate cold start and Worker memory",
    gate: "accepted",
    phase: "pre",
    rank: 3,
    artifact: "none",
    binding: "candidate",
    proof: { kind: "none" },
  },
  {
    id: "issue-117-transitions",
    requirement: "Hosted pending and stale-main Release transitions",
    gate: "accepted",
    phase: "pre",
    rank: 4,
    artifact: "none",
    binding: "candidate",
    proof: { kind: "none" },
  },
];

/** A change to any of these invalidates `release-pipeline-observed`. */
export const RELEASE_PIPELINE_PATHS: readonly RegExp[] = [
  /^tools\/release\//,
  /^\.github\/workflows\/release\.yml$/,
  /^\.changeset\/config\.json$/,
];
