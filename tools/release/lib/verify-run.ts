export interface ReleaseRunEvent {
  readonly action: unknown;
  readonly workflow_run: unknown;
  readonly repository: unknown;
}

export interface ReleaseRunApi {
  getRunJobs(repository: string, runId: number): Promise<unknown>;
  getMainSha(repository: string): Promise<unknown>;
}

export interface ReleaseRunDecision {
  readonly eligible: boolean;
  readonly reason: string;
  readonly sha?: string;
}

/** Fail closed unless a completed main push has its own successful Verify and is still main. */
/**
 * GitHub reports the workflow file of a push run on the default branch as
 * `.github/workflows/ci.yml`; a ref suffix appears for other refs. Both spellings
 * of main are accepted, any other file or ref is not.
 */
const CI_WORKFLOW_PATH = /^\.github\/workflows\/ci\.yml(@(refs\/heads\/)?main)?$/;

export async function verifyReleaseRun(
  event: ReleaseRunEvent,
  repositoryName: string,
  api: ReleaseRunApi,
): Promise<ReleaseRunDecision> {
  const repository = object(event.repository);
  const run = object(event.workflow_run);
  if (event.action !== "completed") return blocked("workflow_run action is not completed");
  if (!repository || repository.full_name !== repositoryName || typeof repository.id !== "number") {
    return blocked("event repository does not match the workflow repository");
  }
  if (!run || run.event !== "push" || run.head_branch !== "main") {
    return blocked("source run is not a push to main");
  }
  if (run.name !== "CI" || !CI_WORKFLOW_PATH.test(String(run.path))) {
    return blocked("source run is not the repository CI workflow");
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    return blocked("source CI run did not complete successfully");
  }
  const sourceRepository = object(run.repository);
  const headRepository = object(run.head_repository);
  if (
    sourceRepository?.id !== repository.id ||
    sourceRepository.full_name !== repositoryName ||
    headRepository?.id !== repository.id ||
    headRepository.full_name !== repositoryName
  ) {
    return blocked("source run is not from this repository");
  }
  if (
    run.pull_requests !== undefined &&
    (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 0)
  ) {
    return blocked("source run is associated with a pull request");
  }
  const sha = run.head_sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    return blocked("source run has no valid commit SHA");
  }
  const runId = run.id;
  if (typeof runId !== "number" || !Number.isSafeInteger(runId)) {
    return blocked("source run has no valid run ID");
  }

  let jobs: unknown;
  let main: unknown;
  try {
    [jobs, main] = await Promise.all([
      api.getRunJobs(repositoryName, runId),
      api.getMainSha(repositoryName),
    ]);
  } catch {
    return blocked("GitHub could not verify the source jobs and current main head");
  }
  const jobList = object(jobs);
  const verifyJobs = Array.isArray(jobList?.jobs)
    ? jobList.jobs.filter((job) => object(job)?.name === "Verify")
    : [];
  if (
    verifyJobs.length !== 1 ||
    object(verifyJobs[0])?.status !== "completed" ||
    object(verifyJobs[0])?.conclusion !== "success"
  ) {
    return blocked("the exact source run has no single successful Verify job");
  }
  const currentMainSha = object(main)?.sha;
  if (currentMainSha !== sha) return blocked("source commit is no longer the current main head");

  return {
    eligible: true,
    reason: "current main commit has a successful Verify from its own CI run",
    sha,
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function blocked(reason: string): ReleaseRunDecision {
  return { eligible: false, reason };
}
