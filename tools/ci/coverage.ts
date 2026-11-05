import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkCoverage, type CommandInventory } from "./lib/coverage.ts";

/** Prints where each mandatory command runs and fails on any coverage violation. */
const root = fileURLToPath(new URL("../..", import.meta.url));
const inventory = JSON.parse(
  readFileSync(`${root}tools/ci/required-commands.json`, "utf8"),
) as CommandInventory;
const report = checkCoverage(readFileSync(`${root}.github/workflows/ci.yml`, "utf8"), inventory);

for (const job of report.mandatoryJobs) {
  console.log(`${job}`);
  for (const placement of report.placements.filter((entry) => entry.job === job))
    console.log(`  ${placement.run}`);
}
console.log(
  `\n${report.placements.length}/${inventory.commands.length} required commands placed in ${report.mandatoryJobs.length} mandatory jobs`,
);
if (report.errors.length > 0) {
  for (const error of report.errors) console.error(`FAIL ${error}`);
  process.exit(1);
}
console.log("CI coverage: PASS");
