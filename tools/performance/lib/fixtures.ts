import type { ArmId } from "./arms.ts";
import type { TargetResult } from "./bench.ts";
import type { BuildMeasurement, Preset } from "./graph.ts";
import { summarizeLatency } from "./metrics.ts";
import type { Sample } from "./metrics.ts";
import { PRESETS, SCHEMA_VERSION } from "./report.ts";
import type { ArmReport, HttpRepetition, PerfReport } from "./report.ts";

/** Builders for complete synthetic reports; shared by the report and scaling tests. */

export const size = (raw: number) => ({
  raw,
  gzip: Math.round(raw / 3),
  brotli: Math.round(raw / 4),
});
export const measurement = (preset: Preset, js: number): BuildMeasurement => ({
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
export const samples = (ms: number[], valid = true): Sample[] =>
  ms.map((m) => ({ ms: m, valid, status: valid ? 200 : 500 }));
export const target = (ms: number[]): TargetResult => ({
  warmup: { requests: 5, problems: [] },
  sequential: { ...summarizeLatency(samples(ms)), wallMs: 100 },
  concurrent: { ...summarizeLatency(samples(ms)), wallMs: 50, concurrency: 8 },
});
export const rep = (repetition: number, base: number): HttpRepetition => ({
  repetition,
  position: 0,
  api: target([base, base + 1, base + 2]),
  ssr: target([base * 4, base * 4 + 1, base * 4 + 2]),
});

export function arm(id: ArmId, js: number, ok = true): ArmReport {
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
    ssrDocumentBytes: { node: 2000, workerd: 2000 },
    browserSmoke: { node: { ok, problems: [] }, workerd: { ok, problems: [] } },
    correctness: { ok, problems: ok ? [] : ["broken"] },
  };
}

export function report(overrides: Partial<PerfReport> = {}): PerfReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: "2026-10-16T00:00:00.000Z",
    islandCount: 1,
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
