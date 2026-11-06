import { describe, expect, it } from "vitest";

import { assessRc, ledgerProblems } from "./rc-readiness.ts";
import type { EvidenceLedger, EvidenceRow, RcFacts } from "./rc-readiness.ts";
import type { RegistryReader } from "./registry.ts";

const CANDIDATE = "abc123";
const row = (overrides: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: "node-production",
  requirement: "Node production process",
  gate: "blocker",
  rank: 1,
  status: "PASS",
  candidate: CANDIDATE,
  link: "https://example.test/run/1",
  note: "",
  ...overrides,
});
const ledger = (rows: readonly EvidenceRow[]): EvidenceLedger => ({
  schema: 1,
  target: "1.0.0-rc.0",
  candidate: CANDIDATE,
  rows,
});
const pkg = { name: "@strata-sc/core", version: "0.2.2" };
const reader =
  (tags = { latest: "0.2.2", next: "0.2.2" }): RegistryReader =>
  (name, version) =>
    Promise.resolve({
      status: "found",
      name,
      versions: { [version]: { dependencies: {} } },
      distTags: tags,
    });
const facts = (overrides: Partial<RcFacts> = {}): RcFacts => ({
  ledger: ledger([row()]),
  packages: [pkg],
  frozenTuple: { [pkg.name]: "0.2.2" },
  pendingChangesets: 0,
  readRegistry: reader(),
  ...overrides,
});

describe("assessRc", () => {
  it("is GO only when every fact and every blocker row holds on this candidate", async () => {
    await expect(assessRc(facts())).resolves.toMatchObject({ verdict: "GO", blockers: [] });
  });

  it.each(["PARTIAL", "FAIL", "NOT RUN"] as const)(
    "treats a %s blocker row as NO-GO",
    async (status) => {
      const result = await assessRc(facts({ ledger: ledger([row({ status })]) }));

      expect(result.verdict).toBe("NO-GO");
      expect(result.blockers[0]).toMatchObject({ id: "node-production" });
    },
  );

  it("does not accept a PASS obtained on another candidate", async () => {
    const result = await assessRc(facts({ ledger: ledger([row({ candidate: "older" })]) }));

    expect(result.verdict).toBe("NO-GO");
    expect(result.blockers[0]!.reason).toMatch(/PASS on older/);
  });

  it("keeps accepted risks visible without blocking", async () => {
    const accepted = row({ id: "streaming", gate: "accepted", status: "NOT RUN" });
    const result = await assessRc(facts({ ledger: ledger([row(), accepted]) }));

    expect(result.verdict).toBe("GO");
    expect(result.accepted).toEqual([accepted]);
  });

  it("blocks dist-tag drift, the state a failed Release leaves behind", async () => {
    const result = await assessRc(
      facts({ readRegistry: reader({ latest: "0.2.2", next: "0.2.1" }) }),
    );

    expect(result.blockers).toMatchObject([{ id: "dist-tag-drift" }]);
  });

  it("blocks a frozen candidate behind the manifests, and unreleased source", async () => {
    const result = await assessRc(
      facts({ frozenTuple: { [pkg.name]: "0.2.1" }, pendingChangesets: 2 }),
    );

    expect(result.blockers.map(({ id }) => id)).toEqual([
      "stale-frozen-candidate",
      "unreleased-source",
    ]);
  });

  it("an unreadable registry is a blocker, never a pass", async () => {
    const result = await assessRc(facts({ readRegistry: () => Promise.reject(new Error("503")) }));

    expect(result.blockers[0]).toMatchObject({ id: "registry-unreadable" });
  });

  it("ranks blockers by impact", async () => {
    const result = await assessRc(
      facts({
        ledger: ledger([
          row({ id: "b", rank: 2, status: "FAIL" }),
          row({ id: "a", rank: 1, status: "FAIL" }),
        ]),
        pendingChangesets: 1,
      }),
    );

    expect(result.blockers.map(({ id }) => id)).toEqual(["unreleased-source", "a", "b"]);
  });
});

describe("ledgerProblems", () => {
  it("accepts a well-formed ledger", () => {
    expect(ledgerProblems(ledger([row()]))).toEqual([]);
  });

  it("refuses a PASS with no link or candidate, and duplicate rows", () => {
    expect(ledgerProblems(ledger([row({ link: null })]))).toEqual([
      "node-production claims PASS without a link and a candidate",
    ]);
    expect(ledgerProblems(ledger([row(), row()]))).toEqual(["duplicate row node-production"]);
  });

  it("refuses a malformed ledger", () => {
    expect(ledgerProblems(null).length).toBeGreaterThan(0);
    expect(ledgerProblems({ schema: 2, rows: [] }).length).toBeGreaterThan(0);
  });
});
