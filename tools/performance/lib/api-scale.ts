import { readFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";

import { summarizeLatency } from "./metrics.ts";
import type { LatencySummary } from "./metrics.ts";

/**
 * The controller/provider scaling dimension of the full-stack benchmark
 * (docs/research/m5-production-qualification.md). `STRATA_PERF_CONTROLLERS=8` adds the same
 * eight-resource API to all four arms: eight controller classes (B, D) or 32 equivalent native
 * Nitro routes (A, C), each with a request-scoped ledger released after the request, one
 * authorization rule, a Standard Schema body with a 1 MiB limit and a failing handler.
 *
 * It measures, it never thresholds latency: the burst is a CORRECTNESS gate under concurrency
 * (every answer has an exact expected status, nothing private leaks, every ledger is released,
 * the next requests are healthy) and its latency is recorded as information only.
 */

export const CONTROLLER_COUNTS = [1, 8] as const;
export type ControllerCount = (typeof CONTROLLER_COUNTS)[number];

/** `STRATA_PERF_CONTROLLERS`: unset or empty is the one-controller baseline; anything else must be listed. */
export function parseControllerCount(value: string | undefined): ControllerCount {
  if (value === undefined || value === "") return 1;

  const found = CONTROLLER_COUNTS.find((count) => String(count) === value.trim());

  if (found === undefined)
    throw new Error(
      `STRATA_PERF_CONTROLLERS must be one of ${CONTROLLER_COUNTS.join(", ")} (got "${value}")`,
    );

  return found;
}

/** The eight resources; the fixture declares the same list (tests/full-stack-performance/fixture/controllers-8). */
export const SCALE_RESOURCES = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"] as const;

export const SCALE_MARKERS = {
  controller: "PERF_SCALE_CONTROLLER_MARKER",
  native: "PERF_SCALE_NATIVE_MARKER",
  /** Thrown by the failing handler: server graph only, never in any response. */
  privateFailure: "PERF_SCALE_PRIVATE_FAILURE_CANARY_7c2e",
} as const;

/** The validated-body limit Strata applies (1 MiB); the native arms enforce the same limit. */
export const BODY_LIMIT_BYTES = 1024 * 1024;

export type BurstKind =
  "read" | "create" | "invalid" | "oversized" | "denied" | "failure" | "ssr" | "island-api";

export interface BurstRequest {
  readonly kind: BurstKind;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly body?: string;
  readonly expectedStatus: number;
  /** True when the arm constructs a request-scoped ledger for it (after authorization). */
  readonly ledger: boolean;
}

const oversized = `{"name":"${"x".repeat(BODY_LIMIT_BYTES + 1024)}","quantity":1}`;

/** One round: every resource read once, and one of each other kind. 15 requests, 12 ledgers. */
export function burstRound(round: number): BurstRequest[] {
  const pick = (offset: number): string => SCALE_RESOURCES[(round + offset) % 8]!;

  return [
    ...SCALE_RESOURCES.map((resource): BurstRequest => ({
      kind: "read",
      method: "GET",
      path: `/api/scale/${resource}/42`,
      expectedStatus: 200,
      ledger: true,
    })),
    {
      kind: "create",
      method: "POST",
      path: `/api/scale/${pick(2)}`,
      body: JSON.stringify({ name: "widget", quantity: 2 }),
      expectedStatus: 201,
      ledger: true,
    },
    {
      kind: "invalid",
      method: "POST",
      path: `/api/scale/${pick(4)}`,
      body: JSON.stringify({ name: "", quantity: -1 }),
      expectedStatus: 400,
      ledger: true,
    },
    {
      kind: "oversized",
      method: "POST",
      path: `/api/scale/${pick(6)}`,
      body: oversized,
      expectedStatus: 413,
      ledger: true,
    },
    {
      kind: "denied",
      method: "DELETE",
      path: `/api/scale/${pick(1)}/42`,
      expectedStatus: 403,
      ledger: false,
    },
    {
      kind: "failure",
      method: "GET",
      path: `/api/scale/${pick(3)}/42/fail`,
      expectedStatus: 500,
      ledger: true,
    },
    { kind: "ssr", method: "GET", path: "/products/42", expectedStatus: 200, ledger: false },
    {
      kind: "island-api",
      method: "GET",
      path: "/api/products/42",
      expectedStatus: 200,
      ledger: false,
    },
  ];
}

export const burstPlan = (rounds: number): BurstRequest[] =>
  Array.from({ length: rounds }, (_, round) => burstRound(round)).flat();

export interface BurstOutcome {
  readonly request: BurstRequest;
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
  readonly ms: number;
}

/** Why one answer is wrong; empty means it is exactly the expected one. */
export function burstProblems(
  outcome: BurstOutcome,
  extra: (outcome: BurstOutcome) => string[] = () => [],
): string[] {
  const { request, status, body, contentType } = outcome;
  const problems: string[] = [];
  const where = `${request.kind} ${request.method} ${request.path.slice(0, 40)}`;

  if (status !== request.expectedStatus) {
    problems.push(`${where}: ${status}, expected ${request.expectedStatus}`);
  }
  if (body.includes(SCALE_MARKERS.privateFailure)) {
    problems.push(`${where}: the private failure text reached the response`);
  }
  if (request.kind !== "ssr" && request.kind !== "failure" && status === request.expectedStatus) {
    if (!contentType?.startsWith("application/json")) {
      problems.push(`${where}: content-type ${contentType}`);
    }
  }
  if (request.kind === "read" && status === 200 && !body.includes(`"id":"42"`)) {
    problems.push(`${where}: unexpected body`);
  }

  return [...problems, ...extra(outcome)];
}

export interface LedgerStats {
  readonly opened: number;
  readonly closed: number;
  readonly open: number;
}

/** Cleanup after a completed burst: every ledger the burst opened was released, none is open. */
export function cleanupProblems(
  before: LedgerStats,
  after: LedgerStats,
  plan: readonly BurstRequest[],
): string[] {
  const expected = plan.filter((request) => request.ledger).length;
  const opened = after.opened - before.opened;
  const closed = after.closed - before.closed;

  return [
    ...(opened === expected ? [] : [`${opened} ledgers opened, expected ${expected}`]),
    ...(closed === opened ? [] : [`${closed} ledgers released of ${opened} opened`]),
    ...(after.open === 0 ? [] : [`${after.open} ledgers still open after the burst`]),
  ];
}

export interface BurstResult {
  readonly requests: number;
  readonly concurrency: number;
  readonly wallMs: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly statuses: Readonly<Record<string, number>>;
  readonly invalid: number;
  readonly firstProblems: readonly string[];
  /** Latency of every answer in the burst (all kinds mixed): information only. */
  readonly latency: LatencySummary;
  readonly cleanup: { readonly before: LedgerStats; readonly after: LedgerStats } | null;
  readonly cleanupProblems: readonly string[];
  readonly healthyAfter: boolean;
}

async function send(base: string, request: BurstRequest): Promise<BurstOutcome> {
  const started = performance.now();

  try {
    const response = await fetch(`${base}${request.path}`, {
      method: request.method,
      ...(request.body
        ? { body: request.body, headers: { "content-type": "application/json" } }
        : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();

    return {
      request,
      status: response.status,
      body,
      contentType: response.headers.get("content-type"),
      ms: performance.now() - started,
    };
  } catch (error) {
    return { request, status: 0, body: String(error), contentType: null, ms: 0 };
  }
}

export async function readLedger(base: string): Promise<LedgerStats | null> {
  try {
    const response = await fetch(`${base}/api/scale/stats`, { signal: AbortSignal.timeout(5_000) });

    return response.ok ? ((await response.json()) as LedgerStats) : null;
  } catch {
    return null;
  }
}

/**
 * The bounded mixed burst: `plan` with at most `concurrency` in flight, in plan order. A failed
 * answer is never retried. Afterwards: the ledger accounting and two healthy follow-up requests.
 */
export async function runBurst(
  base: string,
  plan: readonly BurstRequest[],
  concurrency: number,
  options: {
    readonly validate?: (outcome: BurstOutcome) => string[];
    readonly healthy: () => Promise<boolean>;
  },
): Promise<BurstResult> {
  const before = await readLedger(base);
  const outcomes: BurstOutcome[] = [];
  let next = 0;
  const started = performance.now();

  await Promise.all(
    Array.from({ length: Math.min(concurrency, plan.length) }, async () => {
      while (next < plan.length) {
        const request = plan[next++]!;

        outcomes.push(await send(base, request));
      }
    }),
  );

  const wallMs = performance.now() - started;
  const after = await readLedger(base);
  const problems = outcomes.flatMap((outcome) => burstProblems(outcome, options.validate));
  const count = (key: (o: BurstOutcome) => string): Record<string, number> =>
    outcomes.reduce<Record<string, number>>((acc, o) => {
      acc[key(o)] = (acc[key(o)] ?? 0) + 1;

      return acc;
    }, {});
  const cleanup =
    before && after ? cleanupProblems(before, after, plan) : ["ledger stats unavailable"];

  return {
    requests: outcomes.length,
    concurrency,
    wallMs,
    byKind: count((o) => o.request.kind),
    statuses: count((o) => String(o.status)),
    invalid: outcomes.filter((o) => burstProblems(o, options.validate).length > 0).length,
    firstProblems: [...new Set(problems)].slice(0, 8),
    latency: summarizeLatency(outcomes.map((o) => ({ ms: o.ms, status: o.status, valid: true }))),
    cleanup: before && after ? { before, after } : null,
    cleanupProblems: cleanup,
    healthyAfter: await options.healthy(),
  };
}

// ---------------------------------------------------------------------------
// Keep-alive after an oversized body (the PR #168 regression, D1)

export interface KeepAliveResult {
  readonly first: number;
  readonly second: number;
  /** True when the second request really travelled on the first request's socket. */
  readonly reused: boolean;
}

function once(
  agent: Agent,
  url: URL,
  method: string,
  body?: string,
): Promise<{ status: number; reused: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        agent,
        method,
        headers: body
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
          : {},
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, reused: req.reusedSocket }),
        );
      },
    );

    req.setTimeout(30_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** An oversized validated POST, then a GET on the same keep-alive connection when the server keeps it. */
export async function keepAliveAfterOversized(
  base: string,
  postPath: string,
  getPath: string,
): Promise<KeepAliveResult> {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  try {
    const first = await once(agent, new URL(postPath, base), "POST", oversized);
    const second = await once(agent, new URL(getPath, base), "GET");

    return { first: first.status, second: second.status, reused: second.reused };
  } finally {
    agent.destroy();
  }
}

// ---------------------------------------------------------------------------
// Peak resident memory

/**
 * The kernel's high-water mark of the process's resident set (`VmHWM`, Linux): a true peak.
 * Elsewhere `null`: the caller reports only sampled values and must not call them a peak.
 */
export function peakRssKiB(
  pid: number,
  read = (path: string) => readFileSync(path, "utf8"),
): number | null {
  try {
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(read(`/proc/${pid}/status`));

    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
