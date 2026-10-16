import { describe, expect, it } from "vitest";

import type { ArmId } from "./arms.ts";
import type { TargetResult } from "./bench.ts";
import type { BuildMeasurement, Preset } from "./graph.ts";
import { summarizeLatency } from "./metrics.ts";
import type { Sample } from "./metrics.ts";
import {
  PRESETS,
  RUNTIMES,
  SCHEMA_VERSION,
  aggregate,
  renderMarkdown,
  validateReport,
} from "./report.ts";
import type { ArmReport, HttpRepetition, PerfReport } from "./report.ts";

const size = (raw: number) => ({ raw, gzip: Math.round(raw / 3), brotli: Math.round(raw / 4) });
const measurement = (preset: Preset, js: number): BuildMeasurement => ({
  preset,
  browser: {
    js: { ...size(js), files: 4 },
    initialEntry: { file: "assets/index.js", ...size(js - 10) },
    initialGraph: { ...size(js - 10), files: 1 },
    lazy: { ...size(10), files: 3 },
    css: { ...size(0), files: 0 },
    sourceModulesByPackage: {},
  },
  server: {
    entry: "index.mjs",
    bundledJs: { ...size(1000 + js), files: 5 },
    entryEager: { modules: 2, ...size(100) },
    entryReachable: { modules: 5, ...size(1000 + js) },
    entrySize: size(10),
    chunks: [],
    nodeBuiltins: [],
    externalPackages: [],
    tracedNodeModules: { files: 0, bytes: 0, packages: [] },
  },
  deployable: { directory: "dist/analog", files: 1, bytes: 1, byClass: {} as never },
});
const samples = (ms: number[], valid = true): Sample[] =>
  ms.map((m) => ({ ms: m, valid, status: valid ? 200 : 500 }));
const target = (ms: number[]): TargetResult => ({
  warmup: { requests: 5, problems: [] },
  sequential: { ...summarizeLatency(samples(ms)), wallMs: 100 },
  concurrent: { ...summarizeLatency(samples(ms)), wallMs: 50, concurrency: 8 },
});
const rep = (repetition: number, base: number): HttpRepetition => ({
  repetition,
  position: 0,
  api: target([base, base + 1, base + 2]),
  ssr: target([base * 4, base * 4 + 1, base * 4 + 2]),
});

function arm(id: ArmId, js: number, ok = true): ArmReport {
  return {
    id,
    label: id,
    page: "plain",
    api: "native",
    strataPackages: [],
    builds: Object.fromEntries(
      PRESETS.map((preset) => [
        preset,
        {
          measurement: measurement(preset, js),
          buildMs: [7000, 7100],
          deterministic: true,
          confidentialityProblems: [],
        },
      ]),
    ) as ArmReport["builds"],
    http: { node: ok ? [rep(0, 1), rep(1, 1.1)] : [], workerd: ok ? [rep(0, 2), rep(1, 2.2)] : [] },
    browserSmoke: { node: { ok, problems: [] }, workerd: { ok, problems: [] } },
    correctness: { ok, problems: ok ? [] : ["broken"] },
  };
}

function report(overrides: Partial<PerfReport> = {}): PerfReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-10-16T00:00:00.000Z",
    baseline: {
      startingMainSha: "1297271669ed9c419caf6f9997a3e58bffb06bf2",
      headSha: "a".repeat(40),
      workingTreeClean: true,
    },
    environment: {
      os: "darwin",
      arch: "arm64",
      cpu: "cpu",
      cores: 8,
      node: "v22",
      npm: "10",
      wrangler: "4",
      compatibilityDate: "2026-09-21",
      overrides: {},
    },
    tuple: { vite: "8.3.0" },
    tupleIdentical: true,
    packages: ["core", "analog", "server-components"].map((name) => ({
      name,
      version: "0.0.0",
      sha256: "b".repeat(64),
      bytes: 1,
    })),
    policy: {
      warmup: 5,
      requests: 3,
      concurrency: 8,
      repetitions: 2,
      buildRepetitions: 2,
      compression: { gzipLevel: 9, brotliQuality: 11 },
      orders: [["A", "B", "C", "D"]],
    },
    arms: [arm("A", 1000), arm("B", 1000), arm("C", 1100), arm("D", 1100)],
    negativeControls: [{ name: "x", description: "x", rejected: true, detail: "rejected" }],
    ...overrides,
  };
}

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
