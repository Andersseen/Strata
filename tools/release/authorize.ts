import { appendFile, readFile } from "node:fs/promises";

import { verifyReleaseRun } from "./lib/verify-run.ts";

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as Parameters<
  typeof verifyReleaseRun
>[0];
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repository || !token)
  throw new Error("Release authorization needs repository and GitHub token context.");

const apiRequest = async (path: string): Promise<unknown> => {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}.`);
  return response.json();
};

const runId = (event.workflow_run as { id?: unknown } | undefined)?.id;
if (typeof runId !== "number") throw new Error("Release authorization event has no source run ID.");
const decision = await verifyReleaseRun(event, repository, {
  getRunJobs: (_repository, id) => apiRequest(`/actions/runs/${id}/jobs?per_page=100`),
  getMainSha: () => apiRequest("/commits/main"),
});
if (!decision.eligible || !decision.sha) throw new Error(`Release blocked: ${decision.reason}.`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `sha=${decision.sha}\n`);
}
