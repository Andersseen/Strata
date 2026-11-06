import { planDistTags } from "./dist-tags.ts";
import type { RegistryReader } from "./registry.ts";

/**
 * The RC go/no-go decision (docs/specs/004-first-release-candidate.md), as pure logic: every input is
 * a recorded fact, the output is a verdict and blockers ranked by impact. Registry state is read
 * live; what cannot be recomputed here (a hosted run, a deployment) is a row of
 * tools/release/rc-evidence.json with its link, and only counts when it qualified THIS candidate.
 */

export type EvidenceStatus = "PASS" | "PARTIAL" | "FAIL" | "NOT RUN";

export interface EvidenceRow {
  readonly id: string;
  readonly requirement: string;
  /** `blocker` rows prohibit publishing unless PASS; `accepted` rows are RC-accepted risks. */
  readonly gate: "blocker" | "accepted";
  /** Lower ranks first in the blocker list. */
  readonly rank: number;
  readonly status: EvidenceStatus;
  /** The candidate SHA or tuple this row's status was obtained on. */
  readonly candidate: string | null;
  readonly link: string | null;
  readonly note: string;
}

export interface EvidenceLedger {
  readonly schema: 1;
  readonly target: string;
  /** The candidate every PASS must have been obtained on. */
  readonly candidate: string;
  readonly rows: readonly EvidenceRow[];
}

export interface RcFacts {
  readonly ledger: EvidenceLedger;
  readonly packages: readonly { readonly name: string; readonly version: string }[];
  readonly frozenTuple: Readonly<Record<string, string>>;
  readonly pendingChangesets: number;
  readonly readRegistry: RegistryReader;
}

export interface RcBlocker {
  readonly rank: number;
  readonly id: string;
  readonly reason: string;
}

export interface RcAssessment {
  readonly verdict: "GO" | "NO-GO";
  readonly blockers: readonly RcBlocker[];
  readonly accepted: readonly EvidenceRow[];
}

export function ledgerProblems(value: unknown): string[] {
  const ledger = value as Partial<EvidenceLedger> | null;
  const problems: string[] = [];

  if (ledger?.schema !== 1) problems.push("ledger schema is not 1");
  if (typeof ledger?.candidate !== "string") problems.push("ledger names no candidate");
  if (!Array.isArray(ledger?.rows) || ledger.rows.length === 0) problems.push("ledger has no rows");

  const ids = new Set<string>();

  for (const row of ledger?.rows ?? []) {
    if (ids.has(row.id)) problems.push(`duplicate row ${row.id}`);
    ids.add(row.id);
    if (row.status === "PASS" && (!row.link || !row.candidate)) {
      problems.push(`${row.id} claims PASS without a link and a candidate`);
    }
  }

  return problems;
}

export async function assessRc(facts: RcFacts): Promise<RcAssessment> {
  const { ledger, packages, frozenTuple } = facts;
  const blockers: RcBlocker[] = [];
  const block = (rank: number, id: string, reason: string) => blockers.push({ rank, id, reason });

  for (const pkg of packages) {
    let lookup;
    try {
      lookup = await facts.readRegistry(pkg.name, pkg.version);
    } catch (error) {
      block(1, "registry-unreadable", `${pkg.name}: ${String(error)}`);
      continue;
    }

    if (lookup.status !== "found" || !lookup.versions[pkg.version]) {
      block(2, "unpublished-baseline", `${pkg.name}@${pkg.version} is not on npm`);
      continue;
    }
    for (const { tag, from, to } of planDistTags(lookup.distTags, pkg.version)) {
      block(3, "dist-tag-drift", `${pkg.name} ${tag} is ${from ?? "absent"}, expected ${to}`);
    }
    if (frozenTuple[pkg.name] !== pkg.version) {
      block(
        4,
        "stale-frozen-candidate",
        `the frozen candidate has ${pkg.name}@${frozenTuple[pkg.name] ?? "(none)"}, the manifest ${pkg.version}`,
      );
    }
  }

  if (facts.pendingChangesets > 0) {
    block(
      5,
      "unreleased-source",
      `${facts.pendingChangesets} Changeset(s) describe source changes no published tuple contains`,
    );
  }

  for (const row of ledger.rows) {
    if (row.gate !== "blocker") continue;
    if (row.status !== "PASS") {
      block(10 + row.rank, row.id, `${row.status}: ${row.note}`);
    } else if (row.candidate !== ledger.candidate) {
      block(10 + row.rank, row.id, `PASS on ${row.candidate}, not on ${ledger.candidate}`);
    }
  }

  blockers.sort((a, b) => a.rank - b.rank);

  return {
    verdict: blockers.length === 0 ? "GO" : "NO-GO",
    blockers,
    accepted: ledger.rows.filter(({ gate }) => gate === "accepted"),
  };
}
