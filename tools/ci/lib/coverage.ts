import { parse } from "yaml";

/**
 * Mandatory-CI coverage contract (docs/research/ci-acceleration.md).
 *
 * The CI workflow may regroup its jobs for wall-clock speed, but the set of mandatory commands is
 * fixed by tools/ci/required-commands.json. This check is pure: it reads the workflow text and the
 * inventory and returns every violation, so the unit tests can mutate a copy of the real workflow and
 * prove each rule rejects the regression it exists for.
 */

export interface RequiredCommand {
  readonly run: string;
  /** The job of the five-job baseline pipeline; `null` for a command added after it. */
  readonly baselineJob: string | null;
  /** Why a command without a baseline job became mandatory. */
  readonly added?: string;
  /** `exact` (default) compares the whole trimmed `run:` block; `contains` accepts a multi-line block containing it. */
  readonly match?: "exact" | "contains";
}

export interface CommandInventory {
  readonly aggregateJob: string;
  readonly aggregateName: string;
  readonly nonMandatoryJobs: readonly string[];
  readonly commands: readonly RequiredCommand[];
}

export interface CommandPlacement {
  readonly run: string;
  readonly job: string;
  readonly step: string;
}

export interface CoverageReport {
  readonly errors: readonly string[];
  readonly placements: readonly CommandPlacement[];
  readonly mandatoryJobs: readonly string[];
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

/** A YAML scalar as text; mappings and sequences (never valid where this is used) become "". */
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

const truthyCondition = (value: unknown): boolean =>
  value !== undefined &&
  value !== false &&
  (typeof value === "object" || text(value).trim() !== "");

export function checkCoverage(workflowText: string, inventory: CommandInventory): CoverageReport {
  const errors: string[] = [];
  const placements: CommandPlacement[] = [];
  const workflow: unknown = parse(workflowText);
  if (!isObject(workflow) || !isObject(workflow["jobs"])) {
    return { errors: ["workflow has no jobs"], placements, mandatoryJobs: [] };
  }
  const jobs = workflow["jobs"];

  // Triggers: every pull request and every push to main.
  const on = workflow["on"];
  if (!isObject(on) || !("pull_request" in on))
    errors.push("workflow must run on every pull_request");
  const push = isObject(on) ? on["push"] : undefined;
  if (!isObject(push) || !asArray(push["branches"]).includes("main"))
    errors.push("workflow must run on push to main");
  if (isObject(on) && isObject(on["pull_request"])) {
    const pr = on["pull_request"];
    if ("paths" in pr || "paths-ignore" in pr || "branches" in pr || "branches-ignore" in pr)
      errors.push("pull_request trigger must not be filtered (a filtered PR never gets Verify)");
  }

  // Concurrency: never cancel a main run (its Verify authorizes Release for that exact SHA).
  const concurrency = workflow["concurrency"];
  if (isObject(concurrency)) {
    const cancel = concurrency["cancel-in-progress"];
    if (cancel === true || (typeof cancel === "string" && !cancel.includes("pull_request")))
      errors.push("cancel-in-progress must be limited to pull_request events");
    const group = text(concurrency["group"]);
    if (!group.includes("github.sha") && cancel !== false)
      errors.push("concurrency group must separate main pushes per SHA");
  }

  // Aggregate gate.
  const aggregate = jobs[inventory.aggregateJob];
  const mandatoryJobs = Object.keys(jobs).filter(
    (id) => id !== inventory.aggregateJob && !inventory.nonMandatoryJobs.includes(id),
  );
  if (!isObject(aggregate)) {
    errors.push(`aggregate job \`${inventory.aggregateJob}\` is missing`);
  } else {
    if (aggregate["name"] !== inventory.aggregateName)
      errors.push(`aggregate job must be named \`${inventory.aggregateName}\``);
    if (text(aggregate["if"]).replace(/\s/g, "") !== "always()")
      errors.push(
        "aggregate job must run with `if: always()` so a failed or skipped need fails it",
      );
    if ("continue-on-error" in aggregate)
      errors.push("aggregate job must not set continue-on-error");
    const needs = asArray(aggregate["needs"]).map(String);
    for (const id of mandatoryJobs)
      if (!needs.includes(id))
        errors.push(`\`${inventory.aggregateName}\` does not need \`${id}\``);
    for (const id of needs)
      if (!mandatoryJobs.includes(id))
        errors.push(`\`${inventory.aggregateName}\` needs unknown or non-mandatory job \`${id}\``);
    const steps = asArray(aggregate["steps"]).filter(isObject);
    const gate = steps.find((step) => typeof step["run"] === "string");
    const env = gate && isObject(gate["env"]) ? gate["env"] : {};
    const script = text(gate?.["run"]);
    if (text(env["RESULTS"]).replace(/\s/g, "") !== "${{join(needs.*.result,'')}}")
      errors.push("aggregate gate must read every need result through join(needs.*.result, ' ')");
    if (Number(env["EXPECTED_JOBS"]) !== needs.length)
      errors.push(
        `aggregate gate EXPECTED_JOBS (${text(env["EXPECTED_JOBS"]) || "undefined"}) must equal the ${needs.length} needed jobs`,
      );
    if (!/!=\s*"success"/.test(script) || !/exit 1/.test(script))
      errors.push("aggregate gate must fail on any result other than success");
    if (gate && ("if" in gate || "continue-on-error" in gate))
      errors.push("aggregate gate step must be unconditional");
  }

  // Mandatory jobs: unconditional, never allowed to fail.
  for (const id of mandatoryJobs) {
    const job = jobs[id];
    if (!isObject(job)) continue;
    if (truthyCondition(job["if"])) errors.push(`mandatory job \`${id}\` must be unconditional`);
    if ("continue-on-error" in job)
      errors.push(`mandatory job \`${id}\` must not set continue-on-error`);
  }

  // Every required command exactly once, unconditional, in a mandatory job.
  const runs: { job: string; step: Json; run: string }[] = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    for (const step of asArray(job["steps"]).filter(isObject)) {
      if (typeof step["run"] === "string") runs.push({ job: id, step, run: step["run"].trim() });
    }
  }
  for (const command of inventory.commands) {
    const found = runs.filter(({ run }) =>
      command.match === "contains" ? run.includes(command.run) : run === command.run,
    );
    if (found.length === 0) {
      errors.push(`required command is missing: ${command.run}`);
      continue;
    }
    if (found.length > 1)
      errors.push(`required command runs ${found.length} times: ${command.run}`);
    for (const { job, step } of found) {
      placements.push({ run: command.run, job, step: text(step["name"]) });
      if (!mandatoryJobs.includes(job))
        errors.push(`required command is outside the mandatory jobs (${job}): ${command.run}`);
      if (truthyCondition(step["if"]))
        errors.push(`required command is conditional: ${command.run}`);
      if ("continue-on-error" in step)
        errors.push(`required command may fail silently: ${command.run}`);
    }
  }

  // No unlisted suite: a new `pnpm` command in a mandatory job must be added to the inventory.
  const listed = (run: string): boolean =>
    inventory.commands.some((command) =>
      command.match === "contains" ? run.includes(command.run) : run === command.run,
    );
  for (const { job, run } of runs) {
    if (mandatoryJobs.includes(job) && run.startsWith("pnpm ") && !listed(run))
      errors.push(`command in \`${job}\` is not in tools/ci/required-commands.json: ${run}`);
  }

  return { errors, placements, mandatoryJobs };
}
