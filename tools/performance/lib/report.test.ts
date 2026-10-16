import { describe, expect, it } from "vitest";

import { arm, rep, report, samples, target } from "./fixtures.ts";
import { summarizeLatency } from "./metrics.ts";
import { RUNTIMES, aggregate, renderMarkdown, validateReport } from "./report.ts";
import type { ArmReport, HttpRepetition } from "./report.ts";

describe("validateReport", () => {
  it("accepts a complete, consistent report", () => {
    expect(validateReport(report())).toEqual([]);
  });

  it("requires the starting SHA, environment and policy fields", () => {
    const base = report();
    const problems = validateReport({
      ...base,
      baseline: { ...base.baseline, startingMainSha: "abc" },
      environment: { ...base.environment, cpu: "" },
      policy: { ...base.policy, requests: Number.NaN },
    });

    expect(problems).toEqual(
      expect.arrayContaining(["baseline.startingMainSha", "environment.cpu", "policy.requests"]),
    );
  });

  it("rejects a report whose arms use different dependency tuples", () => {
    expect(validateReport(report({ tupleIdentical: false }))).toContain(
      "tuple differs between arms",
    );
  });

  it("rejects latency data that contains an invalid response", () => {
    const bad = arm("A", 1000);
    const invalid: HttpRepetition = {
      ...rep(0, 1),
      api: { ...target([1]), sequential: { ...summarizeLatency(samples([1], false)), wallMs: 1 } },
    };

    expect(
      validateReport(
        report({
          arms: [
            { ...bad, http: { node: [invalid, rep(1, 1)], workerd: bad.http.workerd } },
            arm("B", 1),
            arm("C", 1),
            arm("D", 1),
          ],
        }),
      ).join(),
    ).toContain("invalid responses entered a measurement");
  });

  it("rejects an arm that failed correctness but still carries latency data", () => {
    const failed = { ...arm("B", 1000), correctness: { ok: false, problems: ["broken"] } };

    expect(
      validateReport(report({ arms: [arm("A", 1), failed, arm("C", 1), arm("D", 1)] })).join(),
    ).toContain("failed correctness but has");
  });

  it("rejects missing repetitions, missing builds and missing arms", () => {
    const short = {
      ...arm("A", 1000),
      http: { node: [rep(0, 1)], workerd: [rep(0, 1), rep(1, 1)] },
    };
    const noBuild = { ...arm("B", 1000), builds: {} as ArmReport["builds"] };

    expect(
      validateReport(report({ arms: [short, arm("B", 1), arm("C", 1), arm("D", 1)] })).join(),
    ).toContain("1 repetitions, expected 2");
    expect(
      validateReport(report({ arms: [arm("A", 1), noBuild, arm("C", 1), arm("D", 1)] })).join(),
    ).toContain("builds.node-server");
    expect(validateReport(report({ arms: [arm("A", 1)] })).join()).toContain(
      "arms (expected A,B,C,D",
    );
  });

  it("rejects a negative control that was not rejected, and a report without controls", () => {
    expect(
      validateReport(
        report({
          negativeControls: [{ name: "weak", description: "", rejected: false, detail: "" }],
        }),
      ).join(),
    ).toContain('negative control "weak" was not rejected');
    expect(validateReport(report({ negativeControls: [] }))).toContain("negativeControls");
  });

  it("checks every packed tarball digest", () => {
    const base = report();

    expect(validateReport({ ...base, packages: base.packages.slice(0, 2) })).toContain(
      "packages (three tarballs expected)",
    );
    expect(
      validateReport({
        ...base,
        packages: base.packages.map((p) => ({ ...p, sha256: "zz" })),
      }).join(),
    ).toContain("sha256");
  });
});

describe("aggregate", () => {
  it("summarizes the per-repetition percentiles and their spread", () => {
    const a = aggregate([rep(0, 1), rep(1, 2)], "api", "sequential");

    expect(a.p50?.min).toBe(2);
    expect(a.p50?.max).toBe(3);
    expect(a.p95?.median).toBe(3.5);
  });

  it("reports nothing for no repetitions", () => {
    expect(aggregate([], "ssr", "concurrent")).toEqual({ p50: null, p95: null });
  });
});

describe("renderMarkdown", () => {
  it("renders deltas against arm A with attribution", () => {
    const md = renderMarkdown(report());

    expect(md).toContain("| C | 1.1 KiB | +100 B (+10.0 %) |");
    expect(md).toContain("interaction (D−B−C+A)");
    expect(md).toContain("starting main 1297271");
  });

  it("never turns a failed arm into a number: it prints n/a and FAIL", () => {
    const md = renderMarkdown(
      report({ arms: [arm("A", 1000), arm("B", 1, false), arm("C", 1100), arm("D", 1100)] }),
    );

    expect(md).toContain("FAIL (1)");
    expect(md).toMatch(/\| B \| n\/a \| n\/a \|/);
    expect(md).not.toContain("| B | 1 B |");
  });

  it("states no performance threshold or verdict", () => {
    expect(renderMarkdown(report()).toLowerCase()).not.toMatch(
      /budget exceeded|regression detected|faster|slower/,
    );
    expect(RUNTIMES).toEqual(["node", "workerd"]);
  });
});
