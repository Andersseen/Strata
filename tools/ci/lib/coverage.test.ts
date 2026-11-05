import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { checkCoverage, type CommandInventory } from "./coverage.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const workflowText = readFileSync(`${root}.github/workflows/ci.yml`, "utf8");
const inventory = JSON.parse(
  readFileSync(`${root}tools/ci/required-commands.json`, "utf8"),
) as CommandInventory;

type Workflow = {
  concurrency: Record<string, unknown>;
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: unknown;
      needs?: string[];
      "continue-on-error"?: unknown;
      steps: Record<string, unknown>[];
    }
  >;
};

/** Applies `edit` to a parsed copy of the real workflow and returns the check's errors. */
function errorsAfter(edit: (workflow: Workflow) => void): readonly string[] {
  const workflow = parse(workflowText) as Workflow;
  edit(workflow);
  return checkCoverage(stringify(workflow), inventory).errors;
}

function stepOf(workflow: Workflow, run: string): Record<string, unknown> {
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps ?? []) if (step["run"] === run) return step;
  throw new Error(`no step runs ${run}`);
}

describe("mandatory CI coverage", () => {
  it("accepts the committed workflow and places every required command once", () => {
    const report = checkCoverage(workflowText, inventory);
    expect(report.errors).toEqual([]);
    expect(report.placements).toHaveLength(inventory.commands.length);
    expect(new Set(report.placements.map((entry) => entry.run)).size).toBe(
      inventory.commands.length,
    );
  });

  it("the inventory matches the pre-split baseline pipeline command for command", () => {
    // The baseline is the five-job pipeline these commands were taken from. Every baseline job is
    // still represented, and no inventory entry is unattributed.
    const jobs = new Set(inventory.commands.map((command) => command.baselineJob));
    expect([...jobs].sort()).toEqual(["apps", "consumers", "graph", "runtime", "static"]);
    expect(inventory.commands).toHaveLength(34);
  });

  it("rejects a removed suite", () => {
    const errors = errorsAfter((workflow) => {
      const job = workflow.jobs["consumers-islands"];
      job.steps = job.steps.filter(
        (step) => step["run"] !== "pnpm test:server-component-installed-island",
      );
    });
    expect(errors).toContain(
      "required command is missing: pnpm test:server-component-installed-island",
    );
  });

  it("rejects a suite that runs twice", () => {
    const errors = errorsAfter((workflow) => {
      workflow.jobs["apps"].steps.push({ run: "pnpm test:server-component-failures" });
    });
    expect(errors).toContain("required command runs 2 times: pnpm test:server-component-failures");
  });

  it("rejects a conditional or failure-tolerant suite", () => {
    const conditional = errorsAfter((workflow) => {
      stepOf(workflow, "pnpm test:server-component-security")["if"] = "github.event_name == 'push'";
    });
    expect(conditional).toContain(
      "required command is conditional: pnpm test:server-component-security",
    );
    const tolerant = errorsAfter((workflow) => {
      stepOf(workflow, "pnpm test:server-component-security")["continue-on-error"] = true;
    });
    expect(tolerant).toContain(
      "required command may fail silently: pnpm test:server-component-security",
    );
  });

  it("rejects a conditional or failure-tolerant mandatory job", () => {
    expect(
      errorsAfter((workflow) => {
        workflow.jobs["runtime-analog"].if = "github.event_name == 'push'";
      }),
    ).toContain("mandatory job `runtime-analog` must be unconditional");
    expect(
      errorsAfter((workflow) => {
        workflow.jobs["runtime-analog"]["continue-on-error"] = true;
      }),
    ).toContain("mandatory job `runtime-analog` must not set continue-on-error");
  });

  it("rejects a mandatory job that Verify does not depend on", () => {
    const errors = errorsAfter((workflow) => {
      workflow.jobs["ci"].needs = workflow.jobs["ci"].needs!.filter((id) => id !== "graph-dev");
    });
    expect(errors).toContain("`Verify` does not need `graph-dev`");
  });

  it("rejects a suite moved to a non-mandatory job", () => {
    const errors = errorsAfter((workflow) => {
      const step = stepOf(workflow, "pnpm test:analog-forms");
      workflow.jobs["runtime-analog"].steps = workflow.jobs["runtime-analog"].steps.filter(
        (candidate) => candidate !== step,
      );
      workflow.jobs["deploy-www"].steps.push(step);
    });
    expect(errors).toContain(
      "required command is outside the mandatory jobs (deploy-www): pnpm test:analog-forms",
    );
  });

  it("rejects an aggregate gate that can pass without every result", () => {
    expect(
      errorsAfter((workflow) => {
        delete workflow.jobs["ci"].if;
      }),
    ).toContain("aggregate job must run with `if: always()` so a failed or skipped need fails it");
    expect(
      errorsAfter((workflow) => {
        const gate = workflow.jobs["ci"].steps[0] as { env: Record<string, string> };
        gate.env["EXPECTED_JOBS"] = "10";
      }),
    ).toContain("aggregate gate EXPECTED_JOBS (10) must equal the 11 needed jobs");
    expect(
      errorsAfter((workflow) => {
        workflow.jobs["ci"].steps[0]["run"] = "echo ok";
      }),
    ).toContain("aggregate gate must fail on any result other than success");
  });

  it("rejects cancelling main runs and filtered pull requests", () => {
    expect(
      errorsAfter((workflow) => {
        workflow.concurrency["cancel-in-progress"] = true;
      }),
    ).toContain("cancel-in-progress must be limited to pull_request events");
    expect(
      errorsAfter((workflow) => {
        workflow.on["pull_request"] = { paths: ["packages/**"] };
      }),
    ).toContain("pull_request trigger must not be filtered (a filtered PR never gets Verify)");
  });

  it("rejects an unlisted suite in a mandatory job", () => {
    const errors = errorsAfter((workflow) => {
      workflow.jobs["apps"].steps.push({ run: "pnpm test:something-new" });
    });
    expect(errors).toContain(
      "command in `apps` is not in tools/ci/required-commands.json: pnpm test:something-new",
    );
  });
});
