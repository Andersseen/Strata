import { describe, expect, it } from "vitest";

import { verifyReleaseRun } from "./verify-run.js";
import type { ReleaseRunApi } from "./verify-run.js";

const sha = "a".repeat(40);
const repositoryName = "Andersseen/Strata";

function fixture(overrides: Record<string, unknown> = {}) {
  const run = {
    id: 42,
    name: "CI",
    path: ".github/workflows/ci.yml@main",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: sha,
    pull_requests: [],
    repository: { id: 1, full_name: repositoryName },
    head_repository: { id: 1, full_name: repositoryName },
    ...overrides,
  };
  const event = {
    action: "completed",
    workflow_run: run,
    repository: { id: 1, full_name: repositoryName },
  };
  const api: ReleaseRunApi = {
    getRunJobs: () =>
      Promise.resolve({
        jobs: [{ name: "Verify", status: "completed", conclusion: "success" }],
      }),
    getMainSha: () => Promise.resolve({ sha }),
  };
  return { event, api };
}

describe("release eligibility", () => {
  it("allows only the current main SHA after that exact CI run's Verify succeeded", async () => {
    const { event, api } = fixture();
    await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toEqual({
      eligible: true,
      reason: "current main commit has a successful Verify from its own CI run",
      sha,
    });
  });

  it.each([".github/workflows/ci.yml", ".github/workflows/ci.yml@refs/heads/main"])(
    "accepts the CI workflow path GitHub reports for main (%s)",
    async (path) => {
      const { event, api } = fixture({ path });
      await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toMatchObject({
        eligible: true,
      });
    },
  );

  it.each([".github/workflows/other.yml", ".github/workflows/ci.yml@refs/heads/feature", "ci.yml"])(
    "rejects another workflow file or ref (%s)",
    async (path) => {
      const { event, api } = fixture({ path });
      await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toMatchObject({
        eligible: false,
      });
    },
  );

  it.each([
    ["failed Verify", { job: { conclusion: "failure", status: "completed" } }, "blocked"],
    ["cancelled Verify", { job: { conclusion: "cancelled", status: "completed" } }, "blocked"],
    ["pending Verify", { job: { conclusion: null, status: "in_progress" } }, "blocked"],
    ["missing Verify", { job: undefined }, "blocked"],
    ["duplicate Verify", { duplicate: true }, "blocked"],
  ])("blocks %s", async (_label, settings) => {
    const { event, api } = fixture();
    api.getRunJobs = () => {
      const job = settings["job"] as Record<string, unknown> | undefined;
      if (job === undefined) return Promise.resolve({ jobs: [] });
      if (settings["duplicate"])
        return Promise.resolve({
          jobs: [
            { name: "Verify", status: "completed", conclusion: "success" },
            { name: "Verify", status: "completed", conclusion: "success" },
          ],
        });
      return Promise.resolve({ jobs: [{ name: "Verify", ...job }] });
    };
    await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toMatchObject({
      eligible: false,
    });
  });

  it.each([
    ["different SHA", { head_sha: "b".repeat(40) }],
    ["pull request event", { event: "pull_request" }],
    ["non-main branch", { head_branch: "release/test" }],
    ["failed overall run", { conclusion: "failure" }],
    ["cancelled overall run", { conclusion: "cancelled" }],
    ["fork source", { head_repository: { id: 2, full_name: "fork/Strata" } }],
    ["unrelated workflow", { path: ".github/workflows/release.yml@main" }],
    ["workflow on another ref", { path: ".github/workflows/ci.yml@release/test" }],
    ["PR-associated run", { pull_requests: [{ number: 7 }] }],
  ])("blocks %s", async (_label, overrides) => {
    const { event, api } = fixture(overrides);
    await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toMatchObject({
      eligible: false,
    });
  });

  it("blocks a stale main SHA, API errors, and a non-completed dispatch", async () => {
    const { event, api } = fixture();
    api.getMainSha = () => Promise.resolve({ sha: "c".repeat(40) });
    await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toMatchObject({
      eligible: false,
    });
    api.getMainSha = () => Promise.reject(new Error("network"));
    await expect(verifyReleaseRun(event, repositoryName, api)).resolves.toMatchObject({
      eligible: false,
    });
    await expect(
      verifyReleaseRun({ ...event, action: "requested" }, repositoryName, api),
    ).resolves.toMatchObject({ eligible: false });
  });

  it("allows a repeated invocation only while the validated SHA remains current", async () => {
    const { event, api } = fixture();
    const first = await verifyReleaseRun(event, repositoryName, api);
    const second = await verifyReleaseRun(event, repositoryName, api);
    expect(first.eligible).toBe(true);
    expect(second).toEqual(first);
  });
});
