import type { ArmReport, PerfReport } from "./report.ts";

/**
 * Deterministic size budgets of the full-stack benchmark (docs/research/m5-production-qualification.md).
 *
 * Enforced only where the evidence is reproducible: browser JavaScript bytes of the node-server
 * build were byte-identical across three fresh builds per arm, on macOS and GitHub-hosted Linux, in
 * the one-island and the three-island/eight-controller profiles (2026-11-05). Server/Worker sizes
 * and every latency stay INFORMATIONAL: they depend on application shape or on a noisy runner.
 * A budget never replaces a correctness check, and a failed arm is never measured against one.
 */

export interface Budget {
  readonly name: string;
  readonly description: string;
  readonly limitBytes: number;
  /** Bytes the report attributes to the budgeted effect, or null when it cannot be computed. */
  readonly measure: (arms: Readonly<Record<string, ArmReport>>) => number | null;
}

const gzip = (arm: ArmReport | undefined): number | undefined =>
  arm?.builds["node-server"].measurement.browser.js.gzip;
const raw = (arm: ArmReport | undefined): number | undefined =>
  arm?.builds["node-server"].measurement.browser.js.raw;
const diff = (a: number | undefined, b: number | undefined): number | null =>
  a === undefined || b === undefined ? null : a - b;

export const BUDGETS: readonly Budget[] = [
  {
    name: "controllers-browser-bytes",
    description:
      "Strata controllers add no browser JavaScript (B−A and D−C, raw bytes): they are server-only",
    limitBytes: 0,
    measure: (arms) => {
      const plain = diff(raw(arms["B"]), raw(arms["A"]));
      const components = diff(raw(arms["D"]), raw(arms["C"]));

      return plain === null || components === null ? null : Math.max(plain, components);
    },
  },
  {
    name: "server-components-browser-gzip",
    description:
      "Server Components browser runtime overhead (C−A, gzip): measured 4.32–4.52 KiB on 0.14 source; 5 KiB budget",
    limitBytes: 5 * 1024,
    measure: (arms) => diff(gzip(arms["C"]), gzip(arms["A"])),
  },
];

export interface BudgetResult {
  readonly name: string;
  readonly description: string;
  readonly limitBytes: number;
  readonly measuredBytes: number | null;
  readonly verdict: "PASS" | "FAIL" | "NOT EVALUATED";
}

/** Evaluates the budgets on arms that passed correctness and built deterministically. */
export function evaluateBudgets(report: Pick<PerfReport, "arms">): BudgetResult[] {
  const usable = Object.fromEntries(
    report.arms
      .filter(
        (arm) =>
          arm.correctness.ok &&
          arm.builds["node-server"].deterministic &&
          arm.builds["cloudflare-pages"].deterministic,
      )
      .map((arm) => [arm.id, arm]),
  );

  return BUDGETS.map((budget) => {
    const measured = budget.measure(usable);

    return {
      name: budget.name,
      description: budget.description,
      limitBytes: budget.limitBytes,
      measuredBytes: measured,
      verdict:
        measured === null ? "NOT EVALUATED" : measured <= budget.limitBytes ? "PASS" : "FAIL",
    };
  });
}
