import { describe, expect, it } from "vitest";

import { arm, report, rep, target } from "./fixtures.ts";
import type { PerfReport } from "./report.ts";
import {
  budgetLines,
  comparabilityProblems,
  renderScalingMarkdown,
  runRelation,
  scalingRows,
} from "./scaling.ts";

const KIB = 1024;

/** Browser JS bytes per arm (the fixture derives gzip as a third and the server graph from it). */
const profile = (
  islandCount: 1 | 3,
  js: readonly [number, number, number, number],
  overrides: Partial<PerfReport> = {},
): PerfReport =>
  report({
    islandCount,
    arms: [arm("A", js[0]), arm("B", js[1]), arm("C", js[2]), arm("D", js[3])],
    ...overrides,
  });

const one = (overrides: Partial<PerfReport> = {}) =>
  profile(1, [100 * KIB, 100 * KIB, 102 * KIB, 102 * KIB], overrides);
const three = (overrides: Partial<PerfReport> = {}) =>
  profile(3, [160 * KIB, 160 * KIB, 165 * KIB, 165 * KIB], overrides);
const metric = (rows: ReturnType<typeof scalingRows>, key: string) =>
  rows.find((row) => row.metric.key === key)!;

describe("comparabilityProblems", () => {
  it("accepts a complete, correct one/three pair measured on one tuple", () => {
    expect(comparabilityProblems(one(), three())).toEqual([]);
  });

  it("rejects an incomplete report", () => {
    const incomplete = three({ negativeControls: [] });

    expect(comparabilityProblems(one(), incomplete)).toEqual([
      "three-island report: negativeControls",
    ]);
  });

  it("rejects profiles that are not one then three", () => {
    expect(comparabilityProblems(three(), one())).toEqual(
      expect.arrayContaining([
        "first report has 3 islands, expected 1",
        "second report has 1 islands, expected 3",
      ]),
    );
  });

  it("rejects mismatched dependency tuples", () => {
    expect(comparabilityProblems(one(), three({ tuple: { vite: "9.0.0" } }))).toContain(
      "dependency tuples differ",
    );
  });

  it("rejects mismatched Strata package versions", () => {
    const base = three();
    const bumped = three({
      packages: base.packages.map((pkg) => ({ ...pkg, version: "0.0.1" })),
    });

    expect(comparabilityProblems(one(), bumped)).toContain("Strata package versions differ");
  });

  it("rejects mismatched compression policy", () => {
    const base = three();
    const other = three({
      policy: { ...base.policy, compression: { gzipLevel: 6, brotliQuality: 11 } },
    });

    expect(comparabilityProblems(one(), other)).toContain("compression settings differ");
  });

  it("rejects different Node, wrangler or workerd compatibility dates", () => {
    const base = three();
    const problems = comparabilityProblems(
      one(),
      three({
        environment: {
          ...base.environment,
          node: "v99",
          wrangler: "9",
          compatibilityDate: "2030-01-01",
        },
      }),
    );

    expect(problems).toEqual(
      expect.arrayContaining([
        "Node versions differ",
        "wrangler versions differ",
        "workerd compatibility dates differ",
      ]),
    );
  });

  it("rejects unexpectedly different arm definitions", () => {
    const base = three();
    const arms = base.arms.map((a) => (a.id === "C" ? { ...a, page: "server-component" } : a));

    expect(comparabilityProblems(one(), three({ arms }))).toContain("arm definitions differ");
  });

  it("rejects a report where an arm failed correctness", () => {
    const base = three();
    const arms = [...base.arms.slice(0, 3), arm("D", 165 * KIB, false)];

    expect(comparabilityProblems(one(), three({ arms }))).toEqual(
      expect.arrayContaining(["three-island arm D failed correctness"]),
    );
  });

  it("rejects invalid responses that entered a measurement", () => {
    const base = three();
    const bad = { ...rep(0, 1), api: target([1, 2]) };
    const invalid = {
      ...bad,
      api: {
        ...bad.api,
        sequential: { ...bad.api.sequential, invalid: 3 },
      },
    };
    const arms = base.arms.map((a) =>
      a.id === "B" ? { ...a, http: { ...a.http, node: [invalid, invalid] } } : a,
    );

    expect(comparabilityProblems(one(), three({ arms })).join(";")).toContain(
      "invalid responses entered a measurement",
    );
  });
});

describe("runRelation", () => {
  it("is same-run for one machine, one commit, close in time", () => {
    expect(runRelation(one(), three())).toBe("same-run");
  });

  it("is cross-run for the same machine kind measured far apart or on another commit", () => {
    expect(runRelation(one(), three({ generatedAt: "2026-10-20T00:00:00.000Z" }))).toBe(
      "cross-run",
    );

    const base = three();

    expect(
      runRelation(one(), three({ baseline: { ...base.baseline, headSha: "c".repeat(40) } })),
    ).toBe("cross-run");
  });

  it("is cross-machine when the CPU differs", () => {
    const base = three();

    expect(
      runRelation(one(), three({ environment: { ...base.environment, cpu: "another cpu" } })),
    ).toBe("cross-machine");
  });
});

describe("scalingRows arithmetic", () => {
  const rows = scalingRows(one(), three());

  it("splits growth into application growth and Strata-attributable overhead growth", () => {
    const raw = metric(rows, "browser.raw");

    expect(raw.applicationGrowth).toBe(60 * KIB);
    expect(raw.attributionOne.serverComponents).toBe(2 * KIB);
    expect(raw.attributionThree.serverComponents).toBe(5 * KIB);
    expect(raw.overheadGrowth.serverComponents).toBe(3 * KIB);
    expect(raw.serverComponentsPerAddedIsland).toBe(1.5 * KIB);
  });

  it("computes the interaction term (D−B−C+A) in each profile and its growth", () => {
    const raw = metric(rows, "browser.raw");

    expect(raw.attributionOne.interaction).toBe(0);
    expect(raw.attributionThree.interaction).toBe(0);
    expect(raw.overheadGrowth.interaction).toBe(0);
    expect(raw.attributionOne.controllers).toBe(0);
  });

  it("keeps zero and negative deltas as numbers, never as missing", () => {
    const shrinking = scalingRows(one(), profile(3, [160 * KIB, 160 * KIB, 161 * KIB, 161 * KIB]));
    const raw = metric(shrinking, "browser.raw");

    expect(raw.overheadGrowth.serverComponents).toBe(-1 * KIB);
    expect(raw.serverComponentsPerAddedIsland).toBe(-0.5 * KIB);
  });

  it("propagates an unmeasured arm as null instead of zero", () => {
    const base = three();
    const arms = [...base.arms.slice(0, 2), arm("C", 1, false), arm("D", 165 * KIB)];
    const raw = metric(scalingRows(one(), three({ arms })), "browser.raw");

    expect(raw.three.C).toBeNull();
    expect(raw.attributionThree.serverComponents).toBeNull();
    expect(raw.attributionThree.interaction).toBeNull();
    expect(raw.overheadGrowth.serverComponents).toBeNull();
    expect(raw.serverComponentsPerAddedIsland).toBeNull();
  });
});

describe("budgetLines", () => {
  const find = (lines: ReturnType<typeof budgetLines>, name: string) =>
    lines.find((line) => line.name.includes(name))!;

  it("judges the one-island Server Components gzip budget at 3 KiB", () => {
    // 102 KiB − 100 KiB raw is 2 KiB, so the gzip delta (a third) is far below 3 KiB.
    expect(find(budgetLines(one()), "Server Components").verdict).toBe("within");

    const heavy = profile(1, [100 * KIB, 100 * KIB, 112 * KIB, 112 * KIB]);

    expect(find(budgetLines(heavy), "Server Components").verdict).toBe("exceeds");
  });

  it("evaluates controllers against zero browser bytes", () => {
    expect(find(budgetLines(one()), "controllers").verdict).toBe("within");
    expect(
      find(budgetLines(profile(1, [100 * KIB, 100 * KIB + 1, 102 * KIB, 102 * KIB])), "controllers")
        .verdict,
    ).toBe("exceeds");
  });

  it("reports not-measured when an arm failed", () => {
    const base = one();
    const arms = [arm("A", 1), arm("B", 1, false), base.arms[2]!, base.arms[3]!];

    expect(find(budgetLines(one({ arms })), "controllers").verdict).toBe("not-measured");
  });

  it("labels every line with the profile it was measured in", () => {
    expect(new Set(budgetLines(three()).map((line) => line.profile))).toEqual(new Set([3]));
  });
});

describe("renderScalingMarkdown", () => {
  it("refuses to render tables for an incomparable pair", () => {
    const text = renderScalingMarkdown(one(), three({ tuple: { vite: "9" } }));

    expect(text).toContain("NOT COMPARABLE");
    expect(text).not.toContain("Candidate budgets");
  });

  it("renders scaling, document size and budget tables for a comparable pair", () => {
    const text = renderScalingMarkdown(one(), three());

    expect(text).toContain("**same-run**");
    expect(text).toContain("A growth");
    expect(text).toContain("SSR document size");
    expect(text).toContain("PROPOSED, reported only, never enforced");
    expect(text).not.toMatch(/\bPASS\b|\bFAIL\b/);
  });

  it("says latency is not comparable across machines", () => {
    const base = three();
    const text = renderScalingMarkdown(
      one(),
      three({ environment: { ...base.environment, cpu: "other" } }),
    );

    expect(text).toContain("**cross-machine**");
    expect(text).toContain("not comparable across runs or machines");
  });
});
