import { ISLAND_COUNTS } from "./arms.ts";
import type { ArmId, IslandCount } from "./arms.ts";
import type { TargetResult } from "./bench.ts";
import type { BuildMeasurement, Preset } from "./graph.ts";
import {
  attribute,
  delta,
  formatBytes,
  formatDelta,
  formatMs,
  median,
  spreadOf,
} from "./metrics.ts";
import type { Spread } from "./metrics.ts";

/**
 * The structured JSON report of the full-stack performance baseline, its completeness
 * check, and the Markdown tables derived from it. Every number is tagged by what it is:
 * MEASURED, ESTIMATED, NOT MEASURED or NOT COMPARABLE.
 */

/** 2: adds `islandCount` (the interactive-island profile the four arms were built with). */
export const SCHEMA_VERSION = 2;

export type Runtime = "node" | "workerd";
export const RUNTIMES: readonly Runtime[] = ["node", "workerd"];
export const PRESETS: readonly Preset[] = ["node-server", "cloudflare-pages"];
export const PRESET_OF: Readonly<Record<Runtime, Preset>> = {
  node: "node-server",
  workerd: "cloudflare-pages",
};

export interface HttpRepetition {
  readonly repetition: number;
  /** Position of this arm in the repetition's run order (0-based). */
  readonly position: number;
  readonly api: TargetResult;
  readonly ssr: TargetResult;
  /** Node only: spawn → first valid answer, polled every 25 ms. Never an isolate cold start. */
  readonly startupMs?: number;
  /** Node only, experimental: resident set size in KiB of the owned server process. */
  readonly rssKiB?: { readonly afterStart: number | null; readonly afterLoad: number | null };
}

export interface PresetReport {
  readonly measurement: BuildMeasurement;
  /** Wall time of each fresh `vite build`, in milliseconds. */
  readonly buildMs: readonly number[];
  /** Whether every repetition emitted the same byte totals. */
  readonly deterministic: boolean;
  readonly confidentialityProblems: readonly string[];
}

export interface ArmReport {
  readonly id: ArmId;
  readonly label: string;
  readonly page: string;
  readonly api: string;
  readonly strataPackages: readonly string[];
  readonly builds: Readonly<Record<Preset, PresetReport>>;
  readonly http: Readonly<Record<Runtime, readonly HttpRepetition[]>>;
  /** Bytes of the SSR document (`/products/42`) per runtime: a measured application effect. */
  readonly ssrDocumentBytes: Readonly<Record<Runtime, number | null>>;
  readonly browserSmoke: Readonly<
    Record<Runtime, { readonly ok: boolean; readonly problems: readonly string[] }>
  >;
  readonly correctness: { readonly ok: boolean; readonly problems: readonly string[] };
}

export interface NegativeControl {
  readonly name: string;
  readonly description: string;
  /** The control passes when the preflight REJECTED the broken variant. */
  readonly rejected: boolean;
  readonly detail: string;
}

export interface PerfReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  /** Interactive client islands in every arm of this report: 1 (PR #86 baseline) or 3. */
  readonly islandCount: IslandCount;
  readonly baseline: {
    readonly startingMainSha: string;
    readonly headSha: string;
    readonly workingTreeClean: boolean;
  };
  readonly environment: {
    readonly os: string;
    readonly arch: string;
    readonly cpu: string;
    readonly cores: number;
    readonly node: string;
    readonly npm: string;
    readonly wrangler: string;
    readonly compatibilityDate: string;
    readonly overrides: Readonly<Record<string, string>>;
  };
  readonly tuple: Readonly<Record<string, string>>;
  readonly tupleIdentical: boolean;
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly policy: {
    readonly warmup: number;
    readonly requests: number;
    readonly concurrency: number;
    readonly repetitions: number;
    readonly buildRepetitions: number;
    readonly compression: { readonly gzipLevel: number; readonly brotliQuality: number };
    readonly orders: readonly (readonly ArmId[])[];
  };
  readonly arms: readonly ArmReport[];
  readonly negativeControls: readonly NegativeControl[];
}

// ---------------------------------------------------------------------------
// Completeness

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Problems that make a report incomplete or self-contradictory; empty means publishable. */
export function validateReport(report: PerfReport): string[] {
  const problems: string[] = [];

  if (report.schemaVersion !== SCHEMA_VERSION) problems.push("schemaVersion");
  if (!ISLAND_COUNTS.includes(report.islandCount)) problems.push("islandCount (1 or 3)");
  if (!/^[0-9a-f]{40}$/.test(report.baseline?.startingMainSha ?? ""))
    problems.push("baseline.startingMainSha");
  for (const key of ["os", "arch", "cpu", "node", "npm", "wrangler", "compatibilityDate"] as const)
    if (!report.environment?.[key]) problems.push(`environment.${key}`);
  if (!isNumber(report.environment?.cores)) problems.push("environment.cores");
  if (Object.keys(report.tuple ?? {}).length === 0) problems.push("tuple");
  if (report.tupleIdentical !== true) problems.push("tuple differs between arms");
  if ((report.packages?.length ?? 0) !== 3) problems.push("packages (three tarballs expected)");
  for (const pkg of report.packages ?? [])
    if (!/^[0-9a-f]{64}$/.test(pkg.sha256)) problems.push(`packages.${pkg.name}.sha256`);
  for (const key of [
    "warmup",
    "requests",
    "concurrency",
    "repetitions",
    "buildRepetitions",
  ] as const)
    if (!isNumber(report.policy?.[key])) problems.push(`policy.${key}`);

  const ids = (report.arms ?? []).map((arm) => arm.id).join(",");

  if (ids !== "A,B,C,D") problems.push(`arms (expected A,B,C,D, got ${ids})`);

  for (const arm of report.arms ?? []) {
    for (const preset of PRESETS) {
      const build = arm.builds?.[preset];

      if (!build) {
        problems.push(`arm ${arm.id}: builds.${preset}`);
        continue;
      }
      if (build.buildMs.length === 0 || !build.buildMs.every(isNumber))
        problems.push(`arm ${arm.id} ${preset}: buildMs`);
      if (!isNumber(build.measurement?.browser?.js?.raw))
        problems.push(`arm ${arm.id} ${preset}: browser.js`);
      if (!isNumber(build.measurement?.server?.bundledJs?.raw))
        problems.push(`arm ${arm.id} ${preset}: server.bundledJs`);
    }
    for (const runtime of RUNTIMES) {
      const reps = arm.http?.[runtime] ?? [];

      if (arm.correctness.ok && reps.length !== report.policy.repetitions)
        problems.push(
          `arm ${arm.id} ${runtime}: ${reps.length} repetitions, expected ${report.policy.repetitions}`,
        );
      if (!arm.correctness.ok && reps.length > 0)
        problems.push(`arm ${arm.id} failed correctness but has ${runtime} latency data`);

      for (const rep of reps)
        for (const name of ["api", "ssr"] as const)
          if (rep[name].sequential.invalid > 0 || rep[name].concurrent.invalid > 0)
            problems.push(
              `arm ${arm.id} ${runtime} ${name}: invalid responses entered a measurement`,
            );
    }
  }

  if (report.negativeControls.length === 0) problems.push("negativeControls");
  for (const control of report.negativeControls ?? [])
    if (!control.rejected) problems.push(`negative control "${control.name}" was not rejected`);

  return problems;
}

// ---------------------------------------------------------------------------
// Aggregation and tables

export interface Aggregate {
  readonly p50: Spread | null;
  readonly p95: Spread | null;
}

export function aggregate(
  reps: readonly HttpRepetition[],
  target: "api" | "ssr",
  mode: "sequential" | "concurrent",
): Aggregate {
  const values = (key: "p50" | "p95"): number[] =>
    reps.map((rep) => rep[target][mode][key]).filter((v): v is number => v !== null);

  return { p50: spreadOf(values("p50")), p95: spreadOf(values("p95")) };
}

export const ARM_IDS: readonly ArmId[] = ["A", "B", "C", "D"];

function armOf(report: PerfReport, id: ArmId): ArmReport | undefined {
  return report.arms.find((arm) => arm.id === id);
}

/** A metric per arm, `null` for an arm that failed correctness (never a fast "success"). */
export function perArm(report: PerfReport, read: (arm: ArmReport) => number | null | undefined) {
  return Object.fromEntries(
    ARM_IDS.map((id) => {
      const arm = armOf(report, id);

      return [id, arm && arm.correctness.ok ? (read(arm) ?? null) : null];
    }),
  ) as Record<ArmId, number | null>;
}

const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n");

function deltaTable(
  report: PerfReport,
  title: string,
  read: (arm: ArmReport) => number | null | undefined,
  format: (n: number) => string,
): string {
  const values = perArm(report, read);
  const base = values.A;
  const a = attribute(values);

  return [
    `**${title}**`,
    "",
    table(
      ["arm", "value", "Δ vs A"],
      ARM_IDS.map((id) => [
        id,
        values[id] === null ? "n/a" : format(values[id]),
        id === "A" ? "—" : formatDelta(delta(values[id], base), format),
      ]),
    ),
    "",
    `Attribution (MEASURED differences, no causal claim): controllers ${a.controllers === null ? "n/a" : format(a.controllers)}, Server Components ${a.serverComponents === null ? "n/a" : format(a.serverComponents)}, combined ${a.combined === null ? "n/a" : format(a.combined)}, interaction (D−B−C+A) ${a.interaction === null ? "n/a" : format(a.interaction)}.`,
  ].join("\n");
}

const sp = (spread: Spread | null | undefined): string =>
  spread === null || spread === undefined
    ? "n/a"
    : `${formatMs(spread.median)} (${formatMs(spread.min)}–${formatMs(spread.max)})`;

/** Markdown summary of the whole report; never contains a threshold or a pass/fail on speed. */
export function renderMarkdown(report: PerfReport): string {
  const out: string[] = [];
  const build = (arm: ArmReport, preset: Preset): PresetReport => arm.builds[preset];

  out.push(
    `## Comparison, ${report.islandCount} interactive island${report.islandCount === 1 ? "" : "s"} (starting main ${report.baseline.startingMainSha.slice(0, 7)})`,
    "",
  );
  out.push(
    table(
      [
        "arm",
        "browser JS",
        "browser JS gzip / br",
        "server graph (node)",
        "Worker (workerd)",
        "build (node, median)",
        "correctness",
      ],
      report.arms.map((arm) => [
        `${arm.id} ${arm.label}`,
        formatBytes(build(arm, "node-server").measurement.browser.js.raw),
        `${formatBytes(build(arm, "node-server").measurement.browser.js.gzip)} / ${formatBytes(build(arm, "node-server").measurement.browser.js.brotli)}`,
        formatBytes(build(arm, "node-server").measurement.server.entryReachable.raw),
        formatBytes(build(arm, "cloudflare-pages").measurement.server.entryReachable.raw),
        formatMs(median(build(arm, "node-server").buildMs)),
        arm.correctness.ok ? "PASS" : `FAIL (${arm.correctness.problems.length})`,
      ]),
    ),
    "",
  );

  out.push(
    deltaTable(
      report,
      "Browser JavaScript, raw (node-server output)",
      (a) => build(a, "node-server").measurement.browser.js.raw,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Browser JavaScript, gzip",
      (a) => build(a, "node-server").measurement.browser.js.gzip,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Browser JavaScript, Brotli",
      (a) => build(a, "node-server").measurement.browser.js.brotli,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Initial entry chunk, raw",
      (a) => build(a, "node-server").measurement.browser.initialEntry.raw,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Server graph reachable from the entry, raw (node-server)",
      (a) => build(a, "node-server").measurement.server.entryReachable.raw,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Cloudflare Worker graph reachable from _worker.js/index.js, raw",
      (a) => build(a, "cloudflare-pages").measurement.server.entryReachable.raw,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Cloudflare Worker graph, gzip",
      (a) => build(a, "cloudflare-pages").measurement.server.entryReachable.gzip,
      formatBytes,
    ),
    "",
    deltaTable(
      report,
      "Build wall time, node-server (median of repetitions)",
      (a) => median(build(a, "node-server").buildMs),
      formatMs,
    ),
    "",
    deltaTable(
      report,
      "Build wall time, cloudflare-pages (median of repetitions)",
      (a) => median(build(a, "cloudflare-pages").buildMs),
      formatMs,
    ),
    "",
  );

  for (const runtime of RUNTIMES) {
    for (const mode of ["sequential", "concurrent"] as const) {
      out.push(
        `**HTTP latency, ${runtime}, ${mode}** — median of ${report.policy.repetitions} repetitions (min–max across repetitions)`,
        "",
        table(
          ["arm", "API p50", "API p95", "SSR p50", "SSR p95"],
          report.arms.map((arm) => {
            if (!arm.correctness.ok) return [arm.id, "n/a", "n/a", "n/a", "n/a"];

            const api = aggregate(arm.http[runtime], "api", mode);
            const ssr = aggregate(arm.http[runtime], "ssr", mode);

            return [arm.id, sp(api.p50), sp(api.p95), sp(ssr.p50), sp(ssr.p95)];
          }),
        ),
        "",
      );
    }
  }

  return out.join("\n");
}
