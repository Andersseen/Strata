import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PerfReport } from "./lib/report.ts";
import { comparabilityProblems, renderScalingMarkdown } from "./lib/scaling.ts";

/**
 * `pnpm test:full-stack-performance:compare <one-island report.json> <three-island report.json> [outDir]`
 *
 * Judges whether the two reports are comparable (same packages, dependency tuple, compression,
 * presets, arm definitions, both complete and correct) and, only then, renders the scaling tables.
 * Exit 1 on an incomparable pair. It never applies a performance threshold.
 */
const [onePath, threePath, outDir] = process.argv.slice(2);

if (onePath === undefined || threePath === undefined) {
  console.error("usage: compare.ts <one-island report.json> <three-island report.json> [outDir]");
  process.exit(2);
}

const read = (path: string): PerfReport => JSON.parse(readFileSync(path, "utf8")) as PerfReport;
const one = read(onePath);
const three = read(threePath);
const problems = comparabilityProblems(one, three);
const markdown = renderScalingMarkdown(one, three);

if (outDir !== undefined) writeFileSync(join(outDir, "comparison.md"), `${markdown}\n`);
console.log(markdown);

if (problems.length > 0) {
  console.error(`\nNOT COMPARABLE (${problems.length} problem(s))`);
  process.exit(1);
}
console.log("\nCOMPARABLE: scaling tables above are evidence, not a threshold check.");
