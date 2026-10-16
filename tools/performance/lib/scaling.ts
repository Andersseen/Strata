import { attribute, formatBytes, formatMs } from "./metrics.ts";
import type { Attribution } from "./metrics.ts";
import { ARM_IDS, PRESETS, RUNTIMES, aggregate, perArm, validateReport } from "./report.ts";
import type { ArmReport, PerfReport } from "./report.ts";

/**
 * Pure helpers that compare a one-island report with a three-island report: whether the two
 * are comparable at all, how far apart they were measured, the size deltas and how they split
 * into application growth versus Strata-attributable growth, and the candidate-budget
 * assessment. Nothing here is a gate: budgets are PROPOSED values reported, never enforced.
 */

const KIB = 1024;

// ---------------------------------------------------------------------------
// Comparability

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const armDefinition = (arm: ArmReport) => [
  arm.id,
  arm.label,
  arm.page,
  arm.api,
  arm.strataPackages,
];

/** Why two reports must not be compared; empty means they are directly comparable in kind. */
export function comparabilityProblems(one: PerfReport, three: PerfReport): string[] {
  const problems: string[] = [];

  problems.push(...validateReport(one).map((p) => `one-island report: ${p}`));
  problems.push(...validateReport(three).map((p) => `three-island report: ${p}`));

  if (one.islandCount !== 1)
    problems.push(`first report has ${one.islandCount} islands, expected 1`);
  if (three.islandCount !== 3)
    problems.push(`second report has ${three.islandCount} islands, expected 3`);
  if (one.schemaVersion !== three.schemaVersion) problems.push("schema versions differ");

  const versions = (report: PerfReport) =>
    Object.fromEntries((report.packages ?? []).map((pkg) => [pkg.name, pkg.version]));

  if (!same(versions(one), versions(three))) problems.push("Strata package versions differ");
  if (!same(one.tuple, three.tuple)) problems.push("dependency tuples differ");
  if (!same(one.policy?.compression, three.policy?.compression))
    problems.push("compression settings differ");
  if (one.environment?.node !== three.environment?.node) problems.push("Node versions differ");
  if (one.environment?.wrangler !== three.environment?.wrangler)
    problems.push("wrangler versions differ");
  if (one.environment?.compatibilityDate !== three.environment?.compatibilityDate)
    problems.push("workerd compatibility dates differ");
  if (!same(one.arms.map(armDefinition), three.arms.map(armDefinition)))
    problems.push("arm definitions differ");
  if (
    !same(
      one.arms.map((arm) => PRESETS.map((preset) => arm.builds[preset]?.measurement?.preset)),
      three.arms.map((arm) => PRESETS.map((preset) => arm.builds[preset]?.measurement?.preset)),
    )
  )
    problems.push("build presets differ");
  for (const [label, report] of [
    ["one-island", one],
    ["three-island", three],
  ] as const)
    for (const arm of report.arms)
      if (!arm.correctness.ok) problems.push(`${label} arm ${arm.id} failed correctness`);

  return problems;
}

export type RunRelation = "same-run" | "cross-run" | "cross-machine";

const environmentKey = (report: PerfReport): string =>
  JSON.stringify([
    report.environment.os,
    report.environment.arch,
    report.environment.cpu,
    report.environment.cores,
    report.environment.node,
    report.environment.npm,
  ]);

/**
 * How the two measurements relate. Only `same-run` (one machine and one commit, started within
 * `windowMs`) supports a latency comparison; the others support size observations alone.
 */
export function runRelation(
  one: PerfReport,
  three: PerfReport,
  windowMs = 3 * 3600_000,
): RunRelation {
  if (environmentKey(one) !== environmentKey(three)) return "cross-machine";

  const gap = Math.abs(Date.parse(one.generatedAt) - Date.parse(three.generatedAt));

  return one.baseline.headSha === three.baseline.headSha && gap <= windowMs
    ? "same-run"
    : "cross-run";
}

// ---------------------------------------------------------------------------
// Scaling arithmetic

export interface Metric {
  readonly key: string;
  readonly title: string;
  readonly read: (arm: ArmReport) => number | null | undefined;
}

export const SIZE_METRICS: readonly Metric[] = [
  {
    key: "browser.raw",
    title: "Browser JS raw",
    read: (a) => a.builds["node-server"].measurement.browser.js.raw,
  },
  {
    key: "browser.gzip",
    title: "Browser JS gzip",
    read: (a) => a.builds["node-server"].measurement.browser.js.gzip,
  },
  {
    key: "browser.brotli",
    title: "Browser JS Brotli",
    read: (a) => a.builds["node-server"].measurement.browser.js.brotli,
  },
  {
    key: "browser.entry",
    title: "Initial entry chunk raw",
    read: (a) => a.builds["node-server"].measurement.browser.initialEntry.raw,
  },
  {
    key: "browser.graph",
    title: "Initial graph raw",
    read: (a) => a.builds["node-server"].measurement.browser.initialGraph.raw,
  },
  {
    key: "browser.lazy",
    title: "Lazy chunks raw",
    read: (a) => a.builds["node-server"].measurement.browser.lazy.raw,
  },
  {
    key: "browser.chunks",
    title: "Browser JS files",
    read: (a) => a.builds["node-server"].measurement.browser.js.files,
  },
  {
    key: "node.graph",
    title: "Node server graph raw",
    read: (a) => a.builds["node-server"].measurement.server.entryReachable.raw,
  },
  {
    key: "node.deploy",
    title: "Node deployable bytes",
    read: (a) => a.builds["node-server"].measurement.deployable.bytes,
  },
  {
    key: "worker.raw",
    title: "Worker graph raw",
    read: (a) => a.builds["cloudflare-pages"].measurement.server.entryReachable.raw,
  },
  {
    key: "worker.gzip",
    title: "Worker graph gzip",
    read: (a) => a.builds["cloudflare-pages"].measurement.server.entryReachable.gzip,
  },
  {
    key: "worker.deploy",
    title: "Pages deployable bytes",
    read: (a) => a.builds["cloudflare-pages"].measurement.deployable.bytes,
  },
];

type PerArm = Record<"A" | "B" | "C" | "D", number | null>;

const minus = (x: number | null, y: number | null): number | null =>
  x === null || y === null ? null : x - y;

export interface ScalingRow {
  readonly metric: Metric;
  readonly one: PerArm;
  readonly three: PerArm;
  readonly attributionOne: Attribution;
  readonly attributionThree: Attribution;
  /** Total growth of the native application A (three islands − one): public island code, no Strata. */
  readonly applicationGrowth: number | null;
  /** Growth of each Strata-attributable overhead between the profiles (three − one). */
  readonly overheadGrowth: Attribution;
  /** The Server Components overhead growth divided by the 2 islands added: observed, not a model. */
  readonly serverComponentsPerAddedIsland: number | null;
}

export function scalingRows(one: PerfReport, three: PerfReport): ScalingRow[] {
  return SIZE_METRICS.map((metric) => {
    const a = perArm(one, metric.read);
    const b = perArm(three, metric.read);
    const attributionOne = attribute(a);
    const attributionThree = attribute(b);
    const grow = (x: number | null, y: number | null) => minus(x, y);
    const overheadGrowth: Attribution = {
      controllers: grow(attributionThree.controllers, attributionOne.controllers),
      serverComponents: grow(attributionThree.serverComponents, attributionOne.serverComponents),
      combined: grow(attributionThree.combined, attributionOne.combined),
      interaction: grow(attributionThree.interaction, attributionOne.interaction),
    };

    return {
      metric,
      one: a,
      three: b,
      attributionOne,
      attributionThree,
      applicationGrowth: grow(b.A, a.A),
      overheadGrowth,
      serverComponentsPerAddedIsland:
        overheadGrowth.serverComponents === null ? null : overheadGrowth.serverComponents / 2,
    };
  });
}

// ---------------------------------------------------------------------------
// Candidate budgets (PR #86): PROPOSED, reported, never enforced

export type BudgetVerdict = "within" | "exceeds" | "not-measured";

export interface BudgetLine {
  readonly name: string;
  readonly profile: 1 | 3;
  readonly limit: string;
  readonly measured: number | null;
  readonly verdict: BudgetVerdict;
}

const budget = (
  name: string,
  profile: 1 | 3,
  limit: string,
  measured: number | null,
  allowed: number,
): BudgetLine => ({
  name,
  profile,
  limit,
  measured,
  verdict: measured === null ? "not-measured" : measured <= allowed ? "within" : "exceeds",
});

/** The four proposed budgets, evaluated against one report. */
export function budgetLines(report: PerfReport): BudgetLine[] {
  const profile = report.islandCount;
  const row = (key: string) => scalingRows(report, report).find((r) => r.metric.key === key)!;
  const att = (key: string) => row(key).attributionOne;

  return [
    budget(
      "controllers: additional browser JS (raw)",
      profile,
      "0 B",
      att("browser.raw").controllers,
      0,
    ),
    budget(
      "Server Components: browser JS gzip",
      profile,
      "≤ 3 KiB (proposed for ONE island)",
      att("browser.gzip").serverComponents,
      3 * KIB,
    ),
    budget(
      "full stack: Node server graph raw",
      profile,
      "≤ 20 KiB",
      att("node.graph").combined,
      20 * KIB,
    ),
    budget(
      "full stack: Worker graph raw",
      profile,
      "≤ 20 KiB",
      att("worker.raw").combined,
      20 * KIB,
    ),
    budget(
      "full stack: Worker graph gzip",
      profile,
      "≤ 8 KiB",
      att("worker.gzip").combined,
      8 * KIB,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Markdown

const cell = (value: number | null, format: (n: number) => string): string =>
  value === null ? "n/a" : format(value);
const signed = (value: number | null): string =>
  value === null ? "n/a" : `${value >= 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
const table = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n");

export function renderScalingMarkdown(one: PerfReport, three: PerfReport): string {
  const problems = comparabilityProblems(one, three);

  if (problems.length > 0)
    return [
      "## Island scaling comparison: NOT COMPARABLE",
      "",
      ...problems.map((problem) => `- ${problem}`),
    ].join("\n");

  const relation = runRelation(one, three);
  const out: string[] = [
    "## Island scaling comparison (1 → 3 interactive islands)",
    "",
    `Relation of the two measurements: **${relation}**` +
      (relation === "same-run"
        ? " (one machine and commit; size and latency differences are directly comparable)."
        : relation === "cross-run"
          ? " (same machine kind, different run: size differences only; latency is not comparable)."
          : " (different machines: size differences only; latency is not comparable)."),
    "",
    "Per metric, the Strata-attributable overheads (B−A controllers, C−A Server Components, D−A combined, D−B−C+A interaction) in each profile, how those overheads GREW, and how much the native application A grew on its own (extra public island code, no Strata). A three-island app naturally has more code; only the overhead-growth columns are Strata-attributable.",
    "",
  ];

  for (const group of ["browser", "node", "worker"] as const) {
    const rows = scalingRows(one, three).filter((r) => r.metric.key.startsWith(group));

    out.push(
      table(
        [
          "metric",
          "A (1→3)",
          "C−A (1)",
          "C−A (3)",
          "D−A (1)",
          "D−A (3)",
          "B−A (1 / 3)",
          "A growth",
          "C−A growth",
          "D−A growth",
        ],
        rows.map((r) => {
          const fmt = r.metric.key.endsWith("chunks") ? (n: number) => String(n) : formatBytes;
          const sg = r.metric.key.endsWith("chunks")
            ? (n: number | null) => cell(n, String)
            : signed;

          return [
            r.metric.title,
            `${cell(r.one.A, fmt)} → ${cell(r.three.A, fmt)}`,
            sg(r.attributionOne.serverComponents),
            sg(r.attributionThree.serverComponents),
            sg(r.attributionOne.combined),
            sg(r.attributionThree.combined),
            `${sg(r.attributionOne.controllers)} / ${sg(r.attributionThree.controllers)}`,
            sg(r.applicationGrowth),
            sg(r.overheadGrowth.serverComponents),
            sg(r.overheadGrowth.combined),
          ];
        }),
      ),
      "",
    );
  }

  out.push(
    "**Interaction (D−B−C+A) per profile**",
    "",
    table(
      ["metric", "1 island", "3 islands"],
      scalingRows(one, three).map((r) => [
        r.metric.title,
        signed(r.attributionOne.interaction),
        signed(r.attributionThree.interaction),
      ]),
    ),
    "",
    "**SSR document size** (bytes, node runtime) and warm SSR p50",
    "",
    table(
      ["arm", "document 1", "document 3", "SSR p50 (1)", "SSR p50 (3)"],
      ARM_IDS.map((id) => {
        const a = one.arms.find((arm) => arm.id === id)!;
        const b = three.arms.find((arm) => arm.id === id)!;
        const p50 = (arm: ArmReport) =>
          aggregate(arm.http.node, "ssr", "sequential").p50?.median ?? null;

        return [
          id,
          cell(a.ssrDocumentBytes.node, formatBytes),
          cell(b.ssrDocumentBytes.node, formatBytes),
          cell(p50(a), formatMs),
          cell(p50(b), formatMs),
        ];
      }),
    ),
    "",
    "Latency differences above include the larger three-island document and component graph; they are application effects, not a framework overhead claim" +
      (relation === "same-run" ? "." : " and are not comparable across runs or machines."),
    "",
    "**Candidate budgets (PR #86; PROPOSED, reported only, never enforced)**",
    "",
    table(
      ["budget", "profile", "limit", "measured", "verdict"],
      [...budgetLines(one), ...budgetLines(three)].map((line) => [
        line.name,
        `${line.profile} island${line.profile === 1 ? "" : "s"}`,
        line.limit,
        signed(line.measured),
        line.verdict,
      ]),
    ),
    "",
    `Runtimes measured: ${RUNTIMES.join(", ")}. Compression: gzip level ${one.policy.compression.gzipLevel}, Brotli quality ${one.policy.compression.brotliQuality}.`,
  );

  return out.join("\n");
}
