import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/**
 * Pure measurement primitives of the full-stack performance baseline
 * (docs/research/full-stack-performance-baseline.md): compression, file
 * classification, de-duplicated totals, percentiles, deltas and formatting.
 * No benchmark policy lives here, so every function is deterministic and unit-tested.
 */

/** What a file is, for the purpose of NOT counting source maps or metadata as code. */
export type FileClass =
  "js" | "css" | "html" | "sourcemap" | "metadata" | "image" | "font" | "other";

export const FILE_CLASSES: readonly FileClass[] = [
  "js",
  "css",
  "html",
  "sourcemap",
  "metadata",
  "image",
  "font",
  "other",
];

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"]);
const FONT = new Set([".woff", ".woff2", ".ttf", ".otf", ".eot"]);

/**
 * `.map` is a source map even when it ends `.js.map`; build metadata is JSON
 * (nitro.json, *.nft.json, _routes.json, _headers, manifests), never executable code.
 */
export function classifyFile(path: string): FileClass {
  const name = path.split("/").pop() ?? path;

  if (name.endsWith(".map")) return "sourcemap";
  if (name === "_headers" || name === "_redirects" || name === "_routes.json") return "metadata";

  const extension = extname(name).toLowerCase();

  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "js";
  if (extension === ".css") return "css";
  if (extension === ".html") return "html";
  if (extension === ".json" || extension === ".txt" || extension === ".webmanifest")
    return "metadata";
  if (IMAGE.has(extension)) return "image";
  if (FONT.has(extension)) return "font";

  return "other";
}

export interface Size {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

export const ZERO_SIZE: Size = { raw: 0, gzip: 0, brotli: 0 };

/** gzip level 9 and Brotli quality 11 (text mode): the same fixed settings for every arm. */
export const COMPRESSION = { gzipLevel: 9, brotliQuality: 11 } as const;

export function gzipBytes(data: Uint8Array): number {
  return gzipSync(data, { level: COMPRESSION.gzipLevel }).byteLength;
}

export function brotliBytes(data: Uint8Array): number {
  return brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: COMPRESSION.brotliQuality,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.byteLength,
    },
  }).byteLength;
}

export function sizeOfBytes(data: Uint8Array): Size {
  return { raw: data.byteLength, gzip: gzipBytes(data), brotli: brotliBytes(data) };
}

export function addSizes(sizes: readonly Size[]): Size {
  return sizes.reduce(
    (total, size) => ({
      raw: total.raw + size.raw,
      gzip: total.gzip + size.gzip,
      brotli: total.brotli + size.brotli,
    }),
    ZERO_SIZE,
  );
}

/** Each file is compressed on its own, as a CDN serves it, then summed. */
export function sizeOfFiles(
  files: readonly string[],
  read: (file: string) => Uint8Array = (file) => readFileSync(file),
): Size {
  return addSizes([...new Set(files)].map((file) => sizeOfBytes(read(file))));
}

export interface ClassTotal {
  readonly files: number;
  readonly bytes: number;
}

/**
 * Bytes and file count per class. A path listed twice is counted once, so a
 * shared asset reachable from several entries never inflates a total.
 */
export function totalsByClass(
  files: readonly string[],
  sizeOf: (file: string) => number,
): Record<FileClass, ClassTotal> {
  const totals = Object.fromEntries(
    FILE_CLASSES.map((fileClass) => [fileClass, { files: 0, bytes: 0 }]),
  ) as Record<FileClass, { files: number; bytes: number }>;

  for (const file of new Set(files)) {
    const entry = totals[classifyFile(file)];

    entry.files += 1;
    entry.bytes += sizeOf(file);
  }

  return totals;
}

// ---------------------------------------------------------------------------
// Statistics

/** Nearest-rank percentile (no interpolation): the smallest sample ≥ p % of all samples. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0 || !(p >= 0 && p <= 100)) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));

  return sorted[rank - 1]!;
}

export function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;

  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface Spread {
  readonly min: number;
  readonly max: number;
  readonly median: number;
  /** (max − min) / median × 100; `null` when the median is 0. */
  readonly rangePct: number | null;
}

/** Run-to-run variability of one statistic measured once per repetition. */
export function spreadOf(values: readonly number[]): Spread | null {
  const mid = median(values);

  if (mid === null) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);

  return { min, max, median: mid, rangePct: mid === 0 ? null : ((max - min) / mid) * 100 };
}

export interface Sample {
  /** Milliseconds from a monotonic clock. */
  readonly ms: number;
  /** Whether the response passed the semantic check; invalid responses never enter a percentile. */
  readonly valid: boolean;
  readonly status: number;
}

export interface LatencySummary {
  readonly requests: number;
  readonly valid: number;
  readonly invalid: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

export function summarizeLatency(samples: readonly Sample[]): LatencySummary {
  const valid = samples.filter((sample) => sample.valid).map((sample) => sample.ms);
  const statuses: Record<string, number> = {};

  for (const sample of samples) {
    const key = String(sample.status);

    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  return {
    requests: samples.length,
    valid: valid.length,
    invalid: samples.length - valid.length,
    statuses,
    p50: percentile(valid, 50),
    p90: percentile(valid, 90),
    p95: percentile(valid, 95),
    min: valid.length === 0 ? null : Math.min(...valid),
    max: valid.length === 0 ? null : Math.max(...valid),
  };
}

// ---------------------------------------------------------------------------
// Deltas

export interface Delta {
  /** value − baseline. */
  readonly abs: number;
  /** (value − baseline) / baseline × 100; `null` when the baseline is 0. */
  readonly pct: number | null;
  /** Why `pct` is absent, when it is. */
  readonly note?: "baseline-zero";
}

/** `null` when either side was not measured: a missing metric is never coerced to 0. */
export function delta(value: number | null | undefined, baseline: number | null | undefined) {
  if (value === null || value === undefined || baseline === null || baseline === undefined)
    return null;
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) return null;

  const abs = value - baseline;

  if (baseline === 0) return { abs, pct: null, note: "baseline-zero" } satisfies Delta;

  return { abs, pct: (abs / baseline) * 100 } satisfies Delta;
}

export interface Attribution {
  /** Controllers only: B − A. */
  readonly controllers: number | null;
  /** Server Components only: C − A. */
  readonly serverComponents: number | null;
  /** Both together: D − A. */
  readonly combined: number | null;
  /** D − B − C + A: what the two capabilities cost beyond the sum of their separate costs. */
  readonly interaction: number | null;
}

/** The 2×2 attribution of a metric across the four arms. Any missing arm leaves its terms `null`. */
export function attribute(arms: {
  readonly A: number | null;
  readonly B: number | null;
  readonly C: number | null;
  readonly D: number | null;
}): Attribution {
  const { A, B, C, D } = arms;
  const minus = (x: number | null, y: number | null): number | null =>
    x === null || y === null ? null : x - y;

  return {
    controllers: minus(B, A),
    serverComponents: minus(C, A),
    combined: minus(D, A),
    interaction: A === null || B === null || C === null || D === null ? null : D - B - C + A,
  };
}

// ---------------------------------------------------------------------------
// Formatting

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "n/a";
  if (Math.abs(bytes) < 1024) return `${bytes} B`;

  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a";
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(2)} s`;

  return `${ms.toFixed(ms >= 100 ? 0 : ms >= 10 ? 1 : 2)} ms`;
}

export function formatPct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "n/a";

  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)} %`;
}

export function formatDelta(d: Delta | null, format: (n: number) => string): string {
  if (d === null) return "n/a";

  const sign = d.abs >= 0 ? "+" : "−";
  const amount = format(Math.abs(d.abs));

  return d.pct === null
    ? `${sign}${amount} (baseline 0)`
    : `${sign}${amount} (${formatPct(d.pct)})`;
}
