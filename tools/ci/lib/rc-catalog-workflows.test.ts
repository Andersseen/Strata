import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { RC_REQUIREMENTS } from "../../release/lib/rc-catalog.ts";

/**
 * The RC gate reads job and step names back from the GitHub API and requires each one by exact name.
 * A name the workflow cannot produce makes its requirement impossible to pass, which no ledger can
 * fix. This test reads the names the way GitHub does: from the parsed YAML, so a ` #` that starts a
 * comment truncates the name here too.
 *
 * It lives in tools/ci, not tools/release, on purpose: a change under tools/release resets the
 * `release-pipeline-observed` evidence.
 */

interface WorkflowStep {
  readonly name?: string;
}

interface WorkflowJob {
  readonly name?: string;
  readonly strategy?: { readonly matrix?: Record<string, unknown> };
  readonly steps?: readonly WorkflowStep[];
}

/** Every name a job can show, with `${{ matrix.x }}` expanded over its matrix values. */
function jobNames(job: WorkflowJob, id: string): readonly string[] {
  const template = job.name ?? id;
  const matrix = job.strategy?.matrix ?? {};
  let names = [template];

  for (const [key, values] of Object.entries(matrix)) {
    if (!Array.isArray(values)) continue;
    const pattern = new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, "g");

    names = names.flatMap((name) => values.map((value) => name.replace(pattern, String(value))));
  }

  return names;
}

const hosted = RC_REQUIREMENTS.flatMap((requirement) =>
  requirement.proof.kind === "hosted-run" ? [{ id: requirement.id, proof: requirement.proof }] : [],
);

describe("RC catalog names exist in their workflows", () => {
  it.each(hosted)("$id", ({ proof }) => {
    const parsed = parse(readFileSync(proof.workflow, "utf8")) as {
      jobs: Record<string, WorkflowJob>;
    };
    const jobs = Object.entries(parsed.jobs).flatMap(([id, job]) =>
      jobNames(job, id).map((name) => ({ name, job })),
    );

    for (const name of proof.jobs) {
      expect(
        jobs.map((job) => job.name),
        `${proof.workflow} has no job "${name}"`,
      ).toContain(name);
    }

    const steps = jobs
      .filter((job) => proof.jobs.includes(job.name))
      .flatMap(({ job }) => job.steps ?? [])
      .map((step) => step.name);

    for (const name of proof.steps ?? []) {
      expect(
        steps,
        `${proof.workflow} has no step "${name}" in ${proof.jobs.join(", ")}`,
      ).toContain(name);
    }
  });

  it("reads a ` #` in an unquoted name as a comment, as GitHub does", () => {
    const [job] = Object.values(
      (
        parse("jobs:\n  a:\n    steps:\n      - name: One (PR #86 baseline)\n") as {
          jobs: Record<string, WorkflowJob>;
        }
      ).jobs,
    );

    expect(job?.steps?.[0]?.name).toBe("One (PR");
  });
});
