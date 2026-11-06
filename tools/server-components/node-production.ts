import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../consumer/lib/exec.ts";
import { summarizeLatency } from "../performance/lib/metrics.ts";
import type { LatencySummary, Sample } from "../performance/lib/metrics.ts";

import { Abort, all, installFullStackConsumer, must } from "./lib/full-stack-install.ts";
import {
  NotAvailable,
  activeCandidate,
  frozenMode,
  installCandidate,
  registryMode,
} from "./lib/full-stack-registry-install.ts";
import { httpSuite, islandSuite, navigationSuite } from "./lib/full-stack-verify.ts";
import { check, failureCount, finish, repoRoot, section } from "./lib/harness.ts";
import {
  installedVersion,
  isolatedEnv,
  startNodeServerCold,
  until,
} from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";

/**
 * `pnpm test:node-production [--frozen|--registry]`: one candidate, as one release identity, through
 * the production entry of a Nitro `node-server` build (`node dist/analog/server/index.mjs`), never a
 * development server (docs/research/rc0-production-qualification.md, "Node production").
 *
 * The functional suites are the ones the full-stack consumer runs. What this adds is the process:
 * cold start, one long-lived server taking every kind of traffic at once, recovery from failures in
 * the middle of that traffic, resource growth, and a clean exit.
 *
 * On GitHub-hosted Linux this is PRODUCTION-PROCESS evidence: a real production build and process on a
 * short-lived runner. It is not a deployment. Nothing here supports a DEPLOYED NODE claim: there is
 * no persistent host, no real network path, no process manager, no uptime measured in days.
 *
 * Latency and memory are observations, not gates: hosted runners are noisy. The gates are correctness
 * under load, no cross-tenant answer, and bounded growth between two identical load rounds.
 *
 *   STRATA_NODE_PRODUCTION_OUT      write the JSON evidence here
 *   STRATA_NODE_PRODUCTION_ROUNDS   load rounds (default 10)
 *   STRATA_NODE_PRODUCTION_REQUESTS requests per round (default 2000)
 *   STRATA_NODE_PRODUCTION_CONCURRENCY in-flight requests (default 12)
 */

const ROUNDS = Number(process.env["STRATA_NODE_PRODUCTION_ROUNDS"] ?? 10);
const REQUESTS = Number(process.env["STRATA_NODE_PRODUCTION_REQUESTS"] ?? 2000);
const CONCURRENCY = Number(process.env["STRATA_NODE_PRODUCTION_CONCURRENCY"] ?? 12);
const OUT = process.env["STRATA_NODE_PRODUCTION_OUT"];
/** Warm-up may grow the heap; from the middle of the run to the end, identical rounds must not. */
const MAX_LATE_RSS_GROWTH_RATIO = 1.25;

const TENANT = {
  alpha: "strata-test-credential=opaque-test-alpha",
  beta: "strata-test-credential=opaque-test-beta",
} as const;

interface Traffic {
  readonly name: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly valid: (status: number, body: string) => boolean;
}

/** Every kind of request a production server sees, interleaved on the same process. */
const TRAFFIC: readonly Traffic[] = [
  {
    name: "ssr",
    path: "/products/42",
    valid: (status, body) => status === 200 && body.includes("data-strata-"),
  },
  {
    name: "controller",
    path: "/api/products/42",
    valid: (status, body) => status === 200 && body.includes('"id"'),
  },
  {
    name: "protected-alpha",
    path: "/api/protected/alpha/products/alpha-product",
    headers: { cookie: TENANT.alpha },
    valid: (status, body) => status === 200 && !body.includes("beta"),
  },
  {
    name: "protected-beta",
    path: "/api/protected/beta/products/beta-product",
    headers: { cookie: TENANT.beta },
    valid: (status, body) => status === 200 && !body.includes("alpha"),
  },
  {
    name: "cross-tenant",
    path: "/api/protected/beta/products/beta-product",
    headers: { cookie: TENANT.alpha },
    valid: (status, body) => status === 403 && !body.includes("beta-product-"),
  },
  {
    name: "unauthenticated",
    path: "/api/protected/alpha/products/alpha-product",
    valid: (status) => status === 401,
  },
  {
    name: "ssr-protected-alpha",
    path: "/protected/alpha",
    headers: { cookie: TENANT.alpha },
    valid: (status, body) => status === 200 && !body.includes("opaque-test-beta"),
  },
  {
    name: "render-failure",
    path: "/render-failure/template",
    valid: (status, body) =>
      status === 500 && body.includes('id="render-failure"') && !body.includes("partial-before"),
  },
];

interface RoundResult {
  readonly round: number;
  readonly wallMs: number;
  readonly invalid: readonly string[];
  readonly rssKiB: number | null;
  readonly openFds: number | null;
  readonly byTraffic: Readonly<Record<string, LatencySummary>>;
}

async function timed(base: string, traffic: Traffic): Promise<Sample & { problem?: string }> {
  const started = performance.now();

  try {
    const response = await fetch(`${base}${traffic.path}`, {
      headers: traffic.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    const ms = performance.now() - started;
    const valid = traffic.valid(response.status, body);

    return {
      ms,
      status: response.status,
      valid,
      ...(valid ? {} : { problem: `${traffic.name}: HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      ms: performance.now() - started,
      status: 0,
      valid: false,
      problem: `${traffic.name}: ${String(error)}`,
    };
  }
}

/** The server's own pid: `RunningServer` wraps a process group led by the node binary. */
function serverPid(port: string): number | null {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  const listed = result.status === 0 ? result.stdout : "";
  const fallback = listed
    ? ""
    : spawnSync("pgrep", ["-f", "dist/analog/server/index.mjs"], { encoding: "utf8" }).stdout;
  const pid = Number((listed || fallback).trim().split("\n")[0]);

  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function rssKiB(pid: number | null): number | null {
  if (pid === null) return null;
  const value = Number(
    spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(),
  );

  return Number.isFinite(value) && value > 0 ? value : null;
}

function openFds(pid: number | null): number | null {
  if (pid === null) return null;
  const proc = `/proc/${pid}/fd`;

  if (existsSync(proc)) return readdirSync(proc).length;

  const listed = spawnSync("lsof", ["-p", String(pid)], { encoding: "utf8" });

  return listed.status === 0 ? listed.stdout.trim().split("\n").length - 1 : null;
}

async function loadRound(base: string, round: number, pid: number | null): Promise<RoundResult> {
  const samples = new Map<string, Sample[]>(TRAFFIC.map(({ name }) => [name, []]));
  const invalid = new Set<string>();
  const started = performance.now();
  let next = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < REQUESTS) {
        const traffic = TRAFFIC[next++ % TRAFFIC.length]!;
        const { problem, ...sample } = await timed(base, traffic);

        samples.get(traffic.name)!.push(sample);
        if (problem) invalid.add(problem);
      }
    }),
  );

  return {
    round,
    wallMs: performance.now() - started,
    invalid: [...invalid],
    rssKiB: rssKiB(pid),
    openFds: openFds(pid),
    byTraffic: Object.fromEntries(
      [...samples].map(([name, values]) => [name, summarizeLatency(values)]),
    ),
  };
}

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-node-production-"));
const consumerDir = join(tmpRoot, "consumer");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
const time = <T>(_label: string, work: () => T): T => work();

const REGISTRY = registryMode() || frozenMode();
const candidateKind = frozenMode() ? "frozen" : REGISTRY ? "registry" : "source-packed";

let server: RunningServer | undefined;
let notAvailable = false;

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");

  const tool = installCandidate({ tmpRoot, consumerDir, env, time }, installFullStackConsumer);
  const versions = Object.fromEntries(
    ["@strata-sc/core", "@strata-sc/analog", "@strata-sc/server-components"].map((name) => [
      name,
      installedVersion(consumerDir, name),
    ]),
  );

  section(`Production build of the ${candidateKind} candidate`);

  const buildStarted = performance.now();
  must(
    run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"], {
      cwd: consumerDir,
      env,
    }),
    "consumer `vite build`",
  );
  const buildMs = performance.now() - buildStarted;
  const entry = join(consumerDir, "dist", "analog", "server", "index.mjs");

  check("the production entry exists (Nitro node-server output)", existsSync(entry));

  section("Process startup: the production entry, cold");

  const startupStarted = performance.now();
  server = await startNodeServerCold(consumerDir, env);
  const listenMs = performance.now() - startupStarted;
  const firstSsr = await timed(server.baseUrl, TRAFFIC[0]!);
  const firstApi = await timed(server.baseUrl, TRAFFIC[1]!);
  const port = new URL(server.baseUrl).port;
  const pid = serverPid(port);
  const baselineRss = rssKiB(pid);
  const baselineFds = openFds(pid);

  check(
    "the first request after a cold start is valid SSR",
    firstSsr.valid,
    String(firstSsr.status),
  );
  check("the first controller request is valid", firstApi.valid, String(firstApi.status));
  check("the server process is observable", pid !== null);
  console.log(
    `observed: listen ${listenMs.toFixed(0)} ms, first SSR ${firstSsr.ms.toFixed(0)} ms, first API ${firstApi.ms.toFixed(0)} ms, RSS ${baselineRss} KiB, fds ${baselineFds}`,
  );

  section("Functional contract on the same long-lived process");

  const http = await httpSuite(server.baseUrl, "node-production", {
    lifecycle: true,
    log: () => server!.output(),
    keepAliveAfter413: true,
  });
  const island = await islandSuite(server.baseUrl, "node-production");
  const navigation = await navigationSuite(server.baseUrl, "node-production");

  check(
    "controllers, Server Components, SSR contract, authorization and request isolation",
    all([...http.controller, ...http.serverComponents]),
  );
  check("browser hydration, single-activation island and interaction", all(island.ok));
  check("document navigation", all(navigation));

  section(
    `Mixed concurrent load: ${ROUNDS} rounds × ${REQUESTS} requests, ${CONCURRENCY} in flight`,
  );

  const rounds: RoundResult[] = [];

  for (let round = 1; round <= ROUNDS; round++) {
    const result = await loadRound(server.baseUrl, round, pid);

    rounds.push(result);
    console.log(
      `round ${round}: ${result.wallMs.toFixed(0)} ms, ${((REQUESTS / result.wallMs) * 1000).toFixed(0)} req/s, RSS ${result.rssKiB} KiB, fds ${result.openFds}, ssr p95 ${result.byTraffic["ssr"]!.p95?.toFixed(1)} ms, api p95 ${result.byTraffic["controller"]!.p95?.toFixed(1)} ms`,
    );
    check(
      `round ${round}: every response was correct for its own request`,
      result.invalid.length === 0,
      result.invalid.join("; "),
    );
  }

  const rss = rounds.map(({ rssKiB: value }) => value);
  const [previous, last] = [rss[Math.floor(rss.length / 2)], rss.at(-1)];

  if (previous && last) {
    check(
      `RSS growth is bounded across identical rounds (${previous} → ${last} KiB)`,
      last / previous < MAX_LATE_RSS_GROWTH_RATIO,
    );
  }

  const fds = rounds.map(({ openFds: value }) => value);
  const [firstFds, lastFds] = [fds[0], fds.at(-1)];

  if (firstFds && lastFds) {
    check(
      `open file descriptors do not accumulate across rounds (${firstFds} → ${lastFds})`,
      lastFds <= firstFds + CONCURRENCY * 2,
    );
  }

  section("Error recovery and clean exit");

  const recovered = await timed(server.baseUrl, TRAFFIC[0]!);
  const serverLog = server.output();

  check("the process is still alive and rendering after the failures", recovered.valid);
  check(
    "no unhandled rejection or uncaught exception in the production log",
    !/unhandledRejection|Unhandled rejection|uncaughtException/i.test(serverLog),
  );
  check("no credential in the production log", !/opaque-test-(alpha|beta)/.test(serverLog));

  const stopStarted = performance.now();
  await server.stop();
  const stopMs = performance.now() - stopStarted;
  const stopped = server;
  server = undefined;

  await until(() => stopped.process.hasExited(), 10_000);
  check("the process exits when stopped", stopped.process.hasExited());
  check(
    "no server process remains on the port",
    pid === null || spawnSync("ps", ["-p", String(pid)]).status !== 0,
  );

  const evidence = {
    kind: "PRODUCTION PROCESS (not a deployment)",
    candidate: candidateKind,
    frozenId: activeCandidate()?.record.id ?? null,
    source: run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim(),
    versions,
    source_kind: tool.source,
    tuple: tool.tuple,
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      hosted: process.env["GITHUB_ACTIONS"] === "true",
      runner: process.env["RUNNER_OS"] ?? null,
    },
    workload: { rounds: ROUNDS, requests: REQUESTS, concurrency: CONCURRENCY },
    buildMs,
    startup: {
      listenMs,
      firstSsrMs: firstSsr.ms,
      firstApiMs: firstApi.ms,
      baselineRss,
      baselineFds,
    },
    rounds,
    stopMs,
    failures: failureCount(),
  };

  console.log(`\nevidence: ${JSON.stringify({ ...evidence, rounds: rounds.length })}`);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`evidence written to ${OUT}`);
  }
} catch (error) {
  if (error instanceof NotAvailable) {
    notAvailable = true;
  } else if (error instanceof Abort) {
    check("the qualification ran to completion", false, error.message);
  } else {
    check(
      "the qualification ran to completion",
      false,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
} finally {
  await server?.stop().catch(() => undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
}

if (notAvailable) {
  console.log("\nNOT AVAILABLE: a selected version is not on npm. Nothing was substituted.");
  process.exit(3);
}

finish(`Node production process (${candidateKind})`);
