import { execFileSync } from "node:child_process";

import type { GitFacts, HostedJob, HostedReader, HostedRun } from "./rc-readiness.ts";

/** The live sources of the RC gate: git in a checkout, and the GitHub REST API. */

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function createGitFacts(cwd: string): GitFacts {
  return {
    head: () => git(cwd, ["rev-parse", "HEAD"])?.trim() ?? "",
    read: (sha, path) => git(cwd, ["show", `${sha}:${path}`]),
    tree: (sha, path) => git(cwd, ["rev-parse", `${sha}:${path}`])?.trim() ?? null,
    changedPaths: (from, to) => {
      const paths = git(cwd, ["diff", "--name-only", from, to]);

      return paths === null ? null : paths.split("\n").filter(Boolean);
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const nullableText = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Fails closed: a body that is not a run is an error, never an empty run. */
export function parseHostedRun(run: unknown, jobs: unknown): HostedRun {
  if (!isRecord(run) || typeof run["id"] !== "number" || !isRecord(jobs)) {
    throw new Error("GitHub answered something that is not a workflow run.");
  }

  const list = Array.isArray(jobs["jobs"]) ? jobs["jobs"] : [];
  const parsed: HostedJob[] = list.filter(isRecord).map((job) => ({
    name: text(job["name"]),
    status: text(job["status"]),
    conclusion: nullableText(job["conclusion"]),
    steps: (Array.isArray(job["steps"]) ? job["steps"] : []).filter(isRecord).map((step) => ({
      name: text(step["name"]),
      conclusion: nullableText(step["conclusion"]),
    })),
  }));
  const repository = isRecord(run["repository"]) ? text(run["repository"]["full_name"]) : "";
  const headRepository = isRecord(run["head_repository"])
    ? text(run["head_repository"]["full_name"])
    : "";

  return {
    id: run["id"],
    repository,
    headRepository,
    path: text(run["path"]),
    event: text(run["event"]),
    headBranch: text(run["head_branch"]),
    headSha: text(run["head_sha"]),
    title: text(run["display_title"]),
    status: text(run["status"]),
    conclusion: nullableText(run["conclusion"]),
    jobs: parsed,
  };
}

export function createHostedReader(
  repository: string,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): HostedReader {
  const api = async (path: string): Promise<unknown> => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}.`);

    return response.json();
  };

  return {
    run: async (runId) => {
      const [run, jobs] = await Promise.all([
        api(`/actions/runs/${runId}`),
        api(`/actions/runs/${runId}/jobs?per_page=100`),
      ]);

      return parseHostedRun(run, jobs);
    },
    pullRequest: async (number) => {
      const pull = await api(`/pulls/${number}`);

      if (!isRecord(pull)) throw new Error("GitHub answered something that is not a pull request.");

      return {
        merged: pull["merged"] === true,
        mergedBy: isRecord(pull["merged_by"]) ? text(pull["merged_by"]["login"]) : null,
        mergeSha: nullableText(pull["merge_commit_sha"]),
      };
    },
  };
}
