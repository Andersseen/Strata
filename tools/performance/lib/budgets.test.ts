import { describe, expect, it } from "vitest";

import { evaluateBudgets } from "./budgets.ts";
import type { ArmReport } from "./report.ts";

/** Minimal arms carrying only what the budgets read. */
function arm(id: string, raw: number, gzip: number, extra: Partial<ArmReport> = {}): ArmReport {
  const build = {
    measurement: { browser: { js: { raw, gzip } } },
    deterministic: true,
  };

  return {
    id,
    correctness: { ok: true, problems: [] },
    builds: { "node-server": build, "cloudflare-pages": build },
    ...extra,
  } as unknown as ArmReport;
}

// The 2026-11-05 one-island measurement (byte-identical locally and on GitHub-hosted Linux).
const measured = [
  arm("A", 273_813, 83_559),
  arm("B", 273_813, 83_559),
  arm("C", 287_114, 88_190),
  arm("D", 287_114, 88_190),
];

describe("deterministic size budgets", () => {
  it("pass on the measured fixture", () => {
    expect(
      evaluateBudgets({ arms: measured }).map((b) => [b.name, b.measuredBytes, b.verdict]),
    ).toEqual([
      ["controllers-browser-bytes", 0, "PASS"],
      ["server-components-browser-gzip", 4_631, "PASS"],
    ]);
  });

  it("fail when controllers ship any browser byte or the Server Components runtime grows past 5 KiB", () => {
    const grown = [
      arm("A", 1000, 100),
      arm("B", 1001, 100),
      arm("C", 9000, 5_221),
      arm("D", 9000, 5_221),
    ];

    expect(evaluateBudgets({ arms: grown }).map((b) => b.verdict)).toEqual(["FAIL", "FAIL"]);
  });

  it("never evaluates a failed or nondeterministic arm", () => {
    const failed = arm("C", 1, 1, { correctness: { ok: false, problems: ["x"] } });
    const nondeterministic = arm("B", 1, 1);

    (nondeterministic.builds["node-server"] as { deterministic: boolean }).deterministic = false;
    expect(
      evaluateBudgets({ arms: [measured[0]!, nondeterministic, failed, measured[3]!] }).map(
        (b) => b.verdict,
      ),
    ).toEqual(["NOT EVALUATED", "NOT EVALUATED"]);
  });
});
