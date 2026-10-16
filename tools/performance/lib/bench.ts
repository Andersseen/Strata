import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { findFreePort } from "../../analog/lib/process.ts";

import { summarizeLatency } from "./metrics.ts";
import type { LatencySummary, Sample } from "./metrics.ts";

/**
 * The HTTP side of the benchmark: real production servers, real sockets, real bodies.
 * Every response is checked semantically; an invalid response is counted, excluded from
 * the percentiles, and fails the arm's correctness preflight.
 */

export interface Target {
  readonly name: "api" | "ssr";
  readonly path: string;
  /** Problems with a response; empty means valid. */
  readonly validate: (outcome: { status: number; body: string }) => string[];
}

export interface Timed {
  readonly ms: number;
  readonly status: number;
  readonly body: string;
}

/** One GET timed with the monotonic `performance.now()`, body fully read inside the timing. */
export async function timedGet(url: string, timeoutMs = 30_000): Promise<Timed> {
  const started = performance.now();

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();

    return { ms: performance.now() - started, status: response.status, body };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, body: String(error) };
  }
}

const asSample = (target: Target, timed: Timed): Sample => ({
  ms: timed.ms,
  status: timed.status,
  valid: target.validate(timed).length === 0,
});

/** Warm-up requests are executed and checked but never sampled. */
export async function warmUp(base: string, target: Target, count: number): Promise<string[]> {
  const problems: string[] = [];

  for (let index = 0; index < count; index++) {
    const timed = await timedGet(`${base}${target.path}`);

    problems.push(...target.validate(timed));
  }

  return [...new Set(problems)];
}

export async function sequential(base: string, target: Target, count: number): Promise<Sample[]> {
  const samples: Sample[] = [];

  for (let index = 0; index < count; index++) {
    samples.push(asSample(target, await timedGet(`${base}${target.path}`)));
  }

  return samples;
}

export interface ConcurrentRun {
  readonly samples: Sample[];
  readonly wallMs: number;
}

/** `count` requests with at most `concurrency` in flight; wall time is the whole batch. */
export async function concurrent(
  base: string,
  target: Target,
  count: number,
  concurrency: number,
): Promise<ConcurrentRun> {
  const samples: Sample[] = [];
  let issued = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    while (issued < count) {
      issued++;
      samples.push(asSample(target, await timedGet(`${base}${target.path}`)));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return { samples, wallMs: performance.now() - started };
}

export interface TargetResult {
  readonly warmup: { readonly requests: number; readonly problems: readonly string[] };
  readonly sequential: LatencySummary & { readonly wallMs: number };
  readonly concurrent: LatencySummary & { readonly wallMs: number; readonly concurrency: number };
}

export interface Workload {
  readonly warmup: number;
  readonly requests: number;
  readonly concurrency: number;
}

export async function measureTarget(
  base: string,
  target: Target,
  { warmup, requests, concurrency }: Workload,
): Promise<TargetResult> {
  const problems = await warmUp(base, target, warmup);
  const seqStarted = performance.now();
  const seq = await sequential(base, target, requests);
  const seqWall = performance.now() - seqStarted;
  const conc = await concurrent(base, target, requests, concurrency);

  return {
    warmup: { requests: warmup, problems },
    sequential: { ...summarizeLatency(seq), wallMs: seqWall },
    concurrent: { ...summarizeLatency(conc.samples), wallMs: conc.wallMs, concurrency },
  };
}

// ---------------------------------------------------------------------------
// Owned Node production server (pid known, so RSS can be sampled)

export interface NodeServer {
  readonly baseUrl: string;
  readonly pid: number;
  /** spawn → first valid answer of `readyPath`, polled every 25 ms. Process start, not an isolate cold start. */
  readonly startupMs: number;
  output(): string;
  /** Resident set size of the server process in KiB, from `ps`; `null` when unavailable. */
  rssKiB(): number | null;
  stop(): Promise<void>;
}

export async function startNodeServer(options: {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readyPath: string;
}): Promise<NodeServer> {
  const port = await findFreePort();
  const started = performance.now();
  const child: ChildProcess = spawn(process.execPath, ["dist/analog/server/index.mjs"], {
    cwd: options.cwd,
    env: {
      ...options.env,
      NODE_ENV: "production",
      PORT: String(port),
      NITRO_PORT: String(port),
      NITRO_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exited = false;
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-64 * 1024);
  };

  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("exit", () => {
    exited = true;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;

  for (;;) {
    if (exited) throw new Error(`Node server exited early:\n${stripVTControlCharacters(output)}`);
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(
        `Node server did not answer ${options.readyPath}:\n${stripVTControlCharacters(output)}`,
      );
    }

    const probe = await timedGet(`${baseUrl}${options.readyPath}`, 2_000);

    if (probe.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const startupMs = performance.now() - started;
  const pid = child.pid!;

  return {
    baseUrl,
    pid,
    startupMs,
    output: () => stripVTControlCharacters(output),
    rssKiB() {
      const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
      const value = Number.parseInt(result.stdout.trim(), 10);

      return result.status === 0 && Number.isFinite(value) ? value : null;
    },
    async stop() {
      if (exited) return;

      const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));

      child.kill("SIGTERM");

      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);

      await done;
      clearTimeout(timer);
    },
  };
}
