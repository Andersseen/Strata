import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  addSizes,
  attribute,
  brotliBytes,
  classifyFile,
  delta,
  formatBytes,
  formatDelta,
  formatMs,
  formatPct,
  gzipBytes,
  median,
  percentile,
  sizeOfBytes,
  sizeOfFiles,
  spreadOf,
  summarizeLatency,
  totalsByClass,
} from "./metrics.ts";

const text = new TextEncoder().encode("export const x = 1;\n".repeat(200));

describe("compression", () => {
  it("measures the size of real gzip and Brotli streams at the documented settings", () => {
    const gzip = gzipSync(text, { level: 9 });
    const brotli = brotliCompressSync(text, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: text.byteLength,
      },
    });

    expect(gunzipSync(gzip).equals(Buffer.from(text))).toBe(true);
    expect(brotliDecompressSync(brotli).equals(Buffer.from(text))).toBe(true);
    expect(gzipBytes(text)).toBe(gzip.byteLength);
    expect(brotliBytes(text)).toBe(brotli.byteLength);
    expect(gzipBytes(text)).toBeLessThan(text.byteLength);
    expect(brotliBytes(text)).toBeLessThan(text.byteLength);
  });

  it("is deterministic for identical input", () => {
    expect(sizeOfBytes(text)).toEqual(sizeOfBytes(new Uint8Array(text)));
  });

  it("measures the empty input without NaN", () => {
    const size = sizeOfBytes(new Uint8Array());

    expect(size.raw).toBe(0);
    expect(Number.isFinite(size.gzip + size.brotli)).toBe(true);
  });

  it("compresses each file separately and counts a repeated path once", () => {
    const read = () => text;
    const once = sizeOfFiles(["a.js"], read);
    const twice = sizeOfFiles(["a.js", "a.js"], read);
    const two = sizeOfFiles(["a.js", "b.js"], read);

    expect(twice).toEqual(once);
    expect(two).toEqual(addSizes([once, once]));
  });
});

describe("classifyFile", () => {
  it.each([
    ["assets/main-abc.js", "js"],
    ["server/chunks/index.mjs", "js"],
    ["assets/main-abc.js.map", "sourcemap"],
    ["assets/styles.css.map", "sourcemap"],
    ["styles.css", "css"],
    ["index.html", "html"],
    ["nitro.json", "metadata"],
    ["chunk.nft.json", "metadata"],
    ["_routes.json", "metadata"],
    ["_headers", "metadata"],
    ["favicon.ico", "image"],
    ["font.woff2", "font"],
    ["blob.bin", "other"],
  ])("%s → %s", (path, expected) => {
    expect(classifyFile(path)).toBe(expected);
  });
});

describe("totalsByClass", () => {
  it("separates source maps from code and never double counts a path", () => {
    const sizes: Record<string, number> = {
      "a.js": 100,
      "a.js.map": 900,
      "b.css": 10,
      "meta.json": 5,
    };
    const totals = totalsByClass(
      ["a.js", "a.js", "a.js.map", "b.css", "meta.json"],
      (f) => sizes[f]!,
    );

    expect(totals.js).toEqual({ files: 1, bytes: 100 });
    expect(totals.sourcemap).toEqual({ files: 1, bytes: 900 });
    expect(totals.css).toEqual({ files: 1, bytes: 10 });
    expect(totals.metadata).toEqual({ files: 1, bytes: 5 });
    expect(totals.html).toEqual({ files: 0, bytes: 0 });
  });
});

describe("statistics", () => {
  it("uses nearest-rank percentiles", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);

    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 90)).toBe(90);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(percentile(samples, 101)).toBeNull();
  });

  it("computes medians and run-to-run spread", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(spreadOf([])).toBeNull();
    expect(spreadOf([10, 12, 11])).toEqual({
      min: 10,
      max: 12,
      median: 11,
      rangePct: (2 / 11) * 100,
    });
    expect(spreadOf([0, 0])?.rangePct).toBeNull();
  });

  it("excludes invalid responses from every percentile but still counts them", () => {
    const summary = summarizeLatency([
      { ms: 1, valid: true, status: 200 },
      { ms: 2, valid: true, status: 200 },
      { ms: 0.01, valid: false, status: 500 },
      { ms: 0.02, valid: false, status: 200 },
    ]);

    expect(summary.requests).toBe(4);
    expect(summary.valid).toBe(2);
    expect(summary.invalid).toBe(2);
    expect(summary.statuses).toEqual({ "200": 3, "500": 1 });
    expect(summary.min).toBe(1);
    expect(summary.p50).toBe(1);
  });

  it("reports no latency at all when every response is invalid", () => {
    const summary = summarizeLatency([{ ms: 0.5, valid: false, status: 500 }]);

    expect(summary.p50).toBeNull();
    expect(summary.p95).toBeNull();
    expect(summary.valid).toBe(0);
  });
});

describe("deltas", () => {
  it("computes absolute and percentage deltas", () => {
    expect(delta(110, 100)).toEqual({ abs: 10, pct: 10 });
    expect(delta(50, 100)).toEqual({ abs: -50, pct: -50 });
  });

  it("handles a zero baseline explicitly", () => {
    expect(delta(5, 0)).toEqual({ abs: 5, pct: null, note: "baseline-zero" });
    expect(delta(0, 0)).toEqual({ abs: 0, pct: null, note: "baseline-zero" });
  });

  it("never coerces a missing metric to zero", () => {
    expect(delta(null, 10)).toBeNull();
    expect(delta(10, undefined)).toBeNull();
    expect(delta(Number.NaN, 10)).toBeNull();
  });

  it("attributes a 2×2 design and reports the interaction", () => {
    expect(attribute({ A: 100, B: 130, C: 150, D: 200 })).toEqual({
      controllers: 30,
      serverComponents: 50,
      combined: 100,
      interaction: 20,
    });
    expect(attribute({ A: 100, B: null, C: 150, D: 200 })).toEqual({
      controllers: null,
      serverComponents: 50,
      combined: 100,
      interaction: null,
    });
  });
});

describe("formatting", () => {
  it("formats bytes, milliseconds and percentages with stable units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(null)).toBe("n/a");
    expect(formatMs(0.123)).toBe("0.12 ms");
    expect(formatMs(12.34)).toBe("12.3 ms");
    expect(formatMs(123.4)).toBe("123 ms");
    expect(formatMs(2500)).toBe("2.50 s");
    expect(formatMs(undefined)).toBe("n/a");
    expect(formatPct(12.345)).toBe("+12.3 %");
    expect(formatPct(-3)).toBe("-3.0 %");
    expect(formatPct(null)).toBe("n/a");
  });

  it("formats deltas including a zero baseline and a missing value", () => {
    expect(formatDelta(delta(1024 * 3, 1024 * 2), formatBytes)).toBe("+1.0 KiB (+50.0 %)");
    expect(formatDelta(delta(5, 0), formatBytes)).toBe("+5 B (baseline 0)");
    expect(formatDelta(delta(10, 20), formatBytes)).toBe("−10 B (-50.0 %)");
    expect(formatDelta(null, formatBytes)).toBe("n/a");
  });
});
