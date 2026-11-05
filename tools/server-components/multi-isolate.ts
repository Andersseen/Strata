import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findFreePort } from "../analog/lib/process.ts";
import { run } from "../consumer/lib/exec.ts";

import { Abort, installFullStackConsumer, must } from "./lib/full-stack-install.ts";
import { READ_OBSERVATION_HEADER, httpSuite } from "./lib/full-stack-verify.ts";
import { check, failureCount, finish, section } from "./lib/harness.ts";
import { isolatedEnv, startServer, startWrangler } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";

/**
 * `pnpm test:full-stack-multi-isolate`: adversarial LOCAL reproduction of a distributed runtime for
 * the full-stack authorization fixture (F6, docs/research/pre1-runtime-hardening.md).
 *
 * Cloudflare runs a deployment in many isolates that share no module state, and consecutive
 * requests of one client may reach different isolates. This harness reproduces that locally with
 * independent server processes (two Nitro Node servers and one local workerd), each with its own
 * module state, behind a deterministic round-robin router that records which instance answered.
 *
 *   1. LEGACY protocol (the pre-fix verifier: count reads in module state, read them back with a
 *      second request), recreated by a harness-only overlay plugin and endpoint:
 *        a. one instance, no restart          → agrees with the real reads (control)
 *        b. read and read-back on different instances → disagrees (F6 reproduced)
 *        c. the serving instance restarted before the read-back → disagrees
 *   2. CORRECTED protocol: the complete protected matrix of httpSuite (API, SSR, 24 + 24 overlapping
 *      principals, live read-before-deny negative control) through the round-robin router, with
 *      every request distributed across the three instances → must pass.
 *
 * No sleeps: the router assigns instances in arrival order and every legacy step is sequential.
 * Never deploys, never publishes. Reuses a verified packed install when
 * STRATA_FULL_STACK_REUSE_ROOT or STRATA_ADVERSARIAL_REUSE_ROOT names one (CI: the full-stack
 * consumer step of the same job); otherwise packs and installs the three packages itself.
 */

const TITLE = "full-stack multi-isolate authorization observation";

/** Harness-only overlay recreating the pre-fix observation: module-local counts, second-request read-back. */
const LEGACY_PLUGIN = `import { getResponseHeader } from "h3";
import { defineNitroPlugin } from "nitropack/runtime";

export const legacyReads = new Map<string, number>();

// Runs after read-observation.ts (plugins load in name order) and records each finished
// request's read count in THIS instance's module state, exactly as the pre-fix fixture did.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("beforeResponse", (event) => {
    const receipt = String(getResponseHeader(event, "x-fixture-read-receipt") ?? "");
    const match = receipt.match(/^([0-9a-f-]{36});reads=(\\d+);/);
    if (match) legacyReads.set(match[1]!, Number(match[2]));
  });
});
`;
const LEGACY_ENDPOINT = `import { defineEventHandler, getRouterParam, setHeader } from "h3";

import { legacyReads } from "../../../plugins/zz-legacy-read-count";

/** The pre-fix read-back: consumes the count from THIS instance's module state (0 if absent). */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, "id") ?? "";
  setHeader(event, "cache-control", "no-store");
  const reads = legacyReads.get(id) ?? 0;
  legacyReads.delete(id);
  return { reads };
});
`;

interface Instance {
  readonly name: string;
  server: RunningServer;
  readonly restart: () => Promise<RunningServer>;
}

/** Deterministic router: request n goes to instance (n mod count), or to an explicitly pinned one. */
class Router {
  readonly served: string[] = [];
  private next = 0;
  private pinned: number | undefined;
  private server: Server | undefined;

  private readonly instances: readonly Instance[];

  constructor(instances: readonly Instance[]) {
    this.instances = instances;
  }

  pin(index: number | undefined): void {
    this.pinned = index;
  }

  async listen(): Promise<string> {
    const port = await findFreePort();
    this.server = createServer((incoming, outgoing) => this.forward(incoming, outgoing));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));

    return `http://127.0.0.1:${port}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private forward(incoming: IncomingMessage, outgoing: ServerResponse): void {
    const index = this.pinned ?? this.next++ % this.instances.length;
    const instance = this.instances[index]!;
    this.served.push(instance.name);
    const target = new URL(instance.server.baseUrl);
    const headers = { ...incoming.headers, host: target.host };
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.rawHeaders);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  }
}

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-multi-isolate-"));
const consumerDir = join(tmpRoot, "consumer");
const nodeBuild = join(tmpRoot, "node-build");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
const reuse =
  process.env["STRATA_FULL_STACK_REUSE_ROOT"] ?? process.env["STRATA_ADVERSARIAL_REUSE_ROOT"];
if (reuse) env["STRATA_FULL_STACK_REUSE_ROOT"] = reuse;
const time = <T>(_label: string, work: () => T): T => work();
const instances: Instance[] = [];
let router: Router | undefined;

const vite = (extraEnv: NodeJS.ProcessEnv = {}) =>
  run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"], {
    cwd: consumerDir,
    env: { ...env, ...extraEnv },
  });

async function nodeInstance(name: string): Promise<Instance> {
  const start = async (): Promise<RunningServer> => {
    const port = await findFreePort();

    return startServer(process.execPath, [join(nodeBuild, "analog", "server", "index.mjs")], {
      cwd: tmpRoot,
      env: { ...env, PORT: String(port), NITRO_PORT: String(port) },
      port,
      readyPath: "/api/products/42",
      timeoutMs: 30_000,
    });
  };
  const instance: Instance = { name, server: await start(), restart: start };

  return instance;
}

/** Sends one protected API request with a fresh observation id; returns the id and the status. */
async function protectedRequest(
  base: string,
  cookie: string | undefined,
  tenant: "alpha" | "beta",
): Promise<{ id: string; status: number; receipt: string | null }> {
  const id = randomUUID();
  const response = await fetch(`${base}/api/protected/${tenant}/products/${tenant}-product`, {
    headers: { ...(cookie ? { cookie } : {}), [READ_OBSERVATION_HEADER]: id },
  });
  await response.text();

  return { id, status: response.status, receipt: response.headers.get("x-fixture-read-receipt") };
}

async function legacyReadBack(base: string, id: string): Promise<number> {
  const response = await fetch(`${base}/api/protected-read-count/${id}`);

  return ((await response.json()) as { reads: number }).reads;
}

const ALPHA = "strata-test-credential=opaque-test-alpha";

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");

  const install = installFullStackConsumer({ tmpRoot, consumerDir, env, time });
  if (!install.ok) throw new Abort("packed full-stack installation failed");

  section("Build: Node and Cloudflare presets with the harness-only legacy overlay");
  mkdirSync(join(consumerDir, "src/server/routes/api/protected-read-count"), { recursive: true });
  writeFileSync(join(consumerDir, "src/server/plugins/zz-legacy-read-count.ts"), LEGACY_PLUGIN);
  writeFileSync(
    join(consumerDir, "src/server/routes/api/protected-read-count/[id].get.ts"),
    LEGACY_ENDPOINT,
  );
  must(vite(), "consumer `vite build` (node-server)");
  cpSync(join(consumerDir, "dist"), nodeBuild, { recursive: true });
  rmSync(join(consumerDir, "dist"), { recursive: true, force: true });
  must(vite({ BUILD_PRESET: "cloudflare-pages" }), "consumer `vite build` (cloudflare-pages)");
  check(
    "both builds contain the fixture's read-observation plugin",
    [join(nodeBuild, "analog", "server"), join(consumerDir, "dist", "analog", "public")].every(
      (dir) => existsSync(dir),
    ) &&
      readFileSync(join(consumerDir, "src/server/plugins/read-observation.ts"), "utf8").length > 0,
  );

  section("Instances: two Nitro Node processes and one local workerd, no shared module state");
  instances.push(await nodeInstance("node-a"), await nodeInstance("node-b"));
  const workerd = await startWrangler(consumerDir, env, "/api/products/42");
  instances.push({
    name: "workerd-c",
    server: workerd,
    restart: () => startWrangler(consumerDir, env, "/api/products/42"),
  });
  router = new Router(instances);
  const base = await router.listen();
  console.log(
    `router: ${base} -> ${instances.map((i) => `${i.name}=${i.server.baseUrl}`).join(", ")}`,
  );

  // ------------------------------------------------------------------------
  section("1a. Legacy protocol, ONE instance (control: shared module state)");
  router.pin(0);
  const single = [
    await protectedRequest(base, ALPHA, "alpha"),
    await protectedRequest(base, undefined, "alpha"),
  ];
  const singleReads = [
    await legacyReadBack(base, single[0]!.id),
    await legacyReadBack(base, single[1]!.id),
  ];
  check(
    "legacy read-back agrees with the real reads when every request reaches the same instance",
    single.map((r) => r.status).join(",") === "200,401" && singleReads.join(",") === "1,0",
    JSON.stringify({ statuses: single.map((r) => r.status), reads: singleReads }),
  );

  section("1b. Legacy protocol, read and read-back on DIFFERENT instances (F6)");
  router.pin(undefined);
  const crossServedFrom = router.served.length;
  const crossReads: number[] = [];
  const crossStatuses: number[] = [];
  for (let index = 0; index < 4; index++) {
    // Sequential: request n and its read-back n+1 reach consecutive (different) instances.
    const reply = await protectedRequest(base, ALPHA, "alpha");
    crossStatuses.push(reply.status);
    crossReads.push(await legacyReadBack(base, reply.id));
  }
  const crossInstances = router.served.slice(crossServedFrom);
  check(
    "the router sent each read-back to a different instance than its request",
    crossInstances.every((name, index) => index % 2 === 1 || name !== crossInstances[index + 1]),
    crossInstances.join(" "),
  );
  check(
    "F6 reproduced: authorized reads that happened are read back as 0 from another instance",
    crossStatuses.every((status) => status === 200) && crossReads.every((reads) => reads === 0),
    JSON.stringify({ statuses: crossStatuses, legacyReads: crossReads }),
  );
  check(
    "the legacy verifier would therefore FAIL the healthy deployment (expected [1,1,1,1])",
    JSON.stringify(crossReads) !== JSON.stringify([1, 1, 1, 1]),
  );

  section("1c. Legacy protocol, the serving instance restarted before the read-back");
  router.pin(0);
  const beforeRestart = await protectedRequest(base, ALPHA, "alpha");
  await instances[0]!.server.stop();
  instances[0]!.server = await instances[0]!.restart();
  const afterRestart = await legacyReadBack(base, beforeRestart.id);
  router.pin(undefined);
  check(
    "a restarted instance has lost the legacy count (read back as 0)",
    beforeRestart.status === 200 && afterRestart === 0,
    JSON.stringify({ status: beforeRestart.status, legacyReads: afterRestart }),
  );
  check(
    "the corrected receipt of the same request was already on its own response",
    /;reads=1;resources=alpha-product$/.test(beforeRestart.receipt ?? ""),
    String(beforeRestart.receipt),
  );

  // ------------------------------------------------------------------------
  section("2. Corrected protocol through the round-robin router (Node + Node + workerd)");
  const correctedFrom = router.served.length;
  const corrected = await httpSuite(base, "multi-isolate", { lifecycle: false });
  const correctedInstances = new Set(router.served.slice(correctedFrom));
  check(
    "the corrected suite's requests were distributed across all three instances",
    correctedInstances.size === 3,
    [...correctedInstances].join(", "),
  );
  check(
    "corrected protocol: controller and SSR authorization proofs pass across isolates",
    [...corrected.controller, ...corrected.serverComponents].every(Boolean),
  );
} catch (error) {
  check(
    `${TITLE} completed`,
    false,
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
} finally {
  await router?.close();
  for (const instance of instances) await instance.server.stop().catch(() => undefined);
  if (process.env["STRATA_KEEP_CONSUMER"] === "1") console.log(`kept: ${tmpRoot}`);
  else rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${failureCount() === 0 ? "MULTI-ISOLATE: GO" : "MULTI-ISOLATE: NO-GO"}`);
finish(TITLE);
