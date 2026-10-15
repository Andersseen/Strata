import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { run } from "../consumer/lib/exec.ts";

import { runConcurrencyMatrix } from "./lib/concurrency-matrix.ts";
import type { MatrixResult } from "./lib/concurrency-matrix.ts";
import { startFaultStub } from "./lib/fault-stub.ts";
import type { Fault } from "./lib/fault-stub.ts";
import { installFullStackConsumer, must, sanitize } from "./lib/full-stack-install.ts";
import { awaitFullStackReady, privateLeaks } from "./lib/full-stack-remote.ts";
import { check, failureCount, repoRoot, section } from "./lib/harness.ts";
import { isolatedEnv, startNodeServer, startWrangler } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";
import { classifyReply, classifyTransportError } from "./lib/response-classification.ts";
import type { RequestExpectation } from "./lib/response-classification.ts";

/**
 * `pnpm test:full-stack-cloudflare-concurrency`: a focused, READ-ONLY diagnostic for the unexplained
 * controller concurrency anomaly of the real Cloudflare run 38727456938
 * (docs/research/full-stack-cloudflare-concurrency.md). It is distinct from the release qualification
 * verdict and never deploys anything.
 *
 *   STRATA_FULLSTACK_CONCURRENCY_TARGETS  comma list of: node, workerd, deployed
 *                                         default: node,workerd (+ deployed when the URL is set)
 *   STRATA_FULLSTACK_DEPLOYED_URL         https://[<hash>.]strata-fullstack-qualification.pages.dev
 *                                         an EXISTING deployment; it is only read, never changed
 *   STRATA_FULLSTACK_CONCURRENCY_STABILIZE_MS  pause before the "after stabilization" rounds (default 15000)
 *   STRATA_FULLSTACK_CONCURRENCY_EVIDENCE_FILE  write the structured result as JSON
 *
 * node/workerd build the SOURCE-PACKED candidate of this checkout; the deployed URL serves whatever
 * artifact it was deployed from, whose identity is recorded separately and never assumed to be this
 * checkout. The matrix is bounded (1500 requests per URL) and is a functional probe, not load evidence.
 */

const TITLE = "full-stack Cloudflare controller concurrency diagnostic";
const PROJECT = "strata-fullstack-qualification";
const ORIGIN = new RegExp(`^https://([a-z0-9]+(-[a-z0-9]+)*\\.)?${PROJECT}\\.pages\\.dev$`);

const env_ = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const givenUrl = env_("STRATA_FULLSTACK_DEPLOYED_URL")?.replace(/\/+$/, "");
const stabilizeMs = Number(env_("STRATA_FULLSTACK_CONCURRENCY_STABILIZE_MS") ?? 15_000);
const targets = (
  env_("STRATA_FULLSTACK_CONCURRENCY_TARGETS") ?? `node,workerd${givenUrl ? ",deployed" : ""}`
)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

if (givenUrl && !ORIGIN.test(givenUrl)) {
  console.error(
    `${TITLE}: STRATA_FULLSTACK_DEPLOYED_URL must be an https origin of ${PROJECT}.pages.dev, got "${givenUrl}".`,
  );
  process.exit(2);
}
if (!Number.isFinite(stabilizeMs) || stabilizeMs < 0 || stabilizeMs > 60_000) {
  console.error(`${TITLE}: STRATA_FULLSTACK_CONCURRENCY_STABILIZE_MS must be 0..60000.`);
  process.exit(2);
}
if (targets.some((t) => !["node", "workerd", "deployed"].includes(t))) {
  console.error(`${TITLE}: unknown target in "${targets.join(",")}" (node, workerd, deployed).`);
  process.exit(2);
}
if (targets.includes("deployed") && !givenUrl) {
  console.error(`${TITLE}: target "deployed" needs STRATA_FULLSTACK_DEPLOYED_URL.`);
  process.exit(2);
}

const evidence: {
  startingMainSha: string;
  checkoutSha: string;
  runner: Record<string, string>;
  candidate?: Record<string, unknown>;
  deployedArtifact?: Record<string, unknown>;
  negativeControls: Record<string, string>;
  matrices: MatrixResult[];
  verdicts: Record<string, string>;
} = {
  startingMainSha: "",
  checkoutSha: run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim(),
  runner: { node: process.version, platform: `${process.platform}-${process.arch}` },
  negativeControls: {},
  matrices: [],
  verdicts: {},
};

evidence.startingMainSha = env_("STRATA_FULLSTACK_BASELINE_SHA") ?? evidence.checkoutSha;

function writeEvidence(): void {
  const file = env_("STRATA_FULLSTACK_CONCURRENCY_EVIDENCE_FILE");

  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Negative controls: the matrix must FAIL on each injected fault and pass on the honest stub.

function classifierControls(): void {
  section("Negative controls: the response classifier");

  const expectation: RequestExpectation = {
    target: "/api/qualification/alpha?cid=c1",
    status: 200,
    contentType: "application/json",
    subject: "alpha",
    correlation: "c1",
    body: JSON.stringify({
      resource: "alpha",
      correlation: "c1",
      path: "/api/qualification/alpha",
    }),
  };
  const reply = (
    status: number,
    type: string | null,
    body: string,
    extra: Record<string, string> = {},
  ) => {
    const headers = new Headers(extra);

    if (type) headers.set("content-type", type);

    return { status, headers, body };
  };
  const classify = (r: ReturnType<typeof reply>) =>
    classifyReply(expectation, r, 1, privateLeaks).class;
  const fp = { "x-fullstack-catalog": "x" };
  const correct = reply(200, "application/json", expectation.body ?? "", fp);

  check("the exact expected answer is a match", classify(correct) === "match");
  check(
    "another request's resource is a controller-response-mismatch",
    classify(
      reply(
        200,
        "application/json",
        JSON.stringify({ resource: "beta", correlation: "c1", path: "/api/qualification/beta" }),
        fp,
      ),
    ) === "controller-response-mismatch",
  );
  check(
    "another request's correlation id is a controller-response-mismatch",
    classify(
      reply(
        200,
        "application/json",
        JSON.stringify({ resource: "alpha", correlation: "c2", path: "/api/qualification/alpha" }),
        fp,
      ),
    ) === "controller-response-mismatch",
  );
  check(
    "a controller 404 JSON where 200 was expected is a controller-response-mismatch",
    classify(reply(404, "application/json", '{"error":"not_found"}')) ===
      "controller-response-mismatch",
  );
  check(
    "a Cloudflare-looking HTML 404 without the fingerprint is an edge-response",
    classify(reply(404, "text/html", "<html>404</html>", { server: "cloudflare" })) ===
      "edge-response",
  );
  check(
    "an Angular HTML fall-through with status 200 is unclassified (not an edge page, not the controller)",
    classify(reply(200, "text/html", "<html>app</html>")) === "unclassified",
  );
  check(
    "a transport error carries the error code and no status",
    (() => {
      const sample = classifyTransportError(
        expectation,
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
        3,
      );

      return (
        sample.classification === "transport-error" &&
        sample.actualStatus === null &&
        sample.transportError?.includes("ECONNRESET") === true
      );
    })(),
  );
  check(
    "a body carrying a synthetic private value fails the gate and is withheld from the sample",
    (() => {
      const leaked = classifyReply(
        expectation,
        reply(
          200,
          "application/json",
          `${expectation.body} FULLSTACK_PRIVATE_SUPPLIER_CANARY_9f3c`,
          fp,
        ),
        1,
        privateLeaks,
      );

      return (
        leaked.class !== "match" &&
        leaked.sample?.privateValueInBody === true &&
        leaked.sample.bodyPrefix === "[withheld: private value]"
      );
    })(),
  );
  check(
    "the sample body prefix is bounded",
    (classifyReply(expectation, reply(500, "text/plain", "x".repeat(5000)), 1, privateLeaks).sample
      ?.bodyPrefix.length ?? 9999) <= 160,
  );
}

async function faultControls(): Promise<void> {
  section("Negative controls: the matrix against a deliberately faulty stub (loopback only)");

  const expected: Record<Fault, { reproduced: boolean; classes: string[] }> = {
    honest: { reproduced: false, classes: [] },
    swap: { reproduced: true, classes: ["controller-response-mismatch"] },
    "wrong-cid": { reproduced: true, classes: ["controller-response-mismatch"] },
    "edge-404": { reproduced: true, classes: ["edge-response"] },
    "wrong-404": { reproduced: true, classes: ["controller-response-mismatch"] },
    drop: { reproduced: true, classes: ["transport-error"] },
  };

  for (const [fault, want] of Object.entries(expected) as [Fault, (typeof expected)[Fault]][]) {
    const stub = await startFaultStub(fault);

    try {
      const result = await runConcurrencyMatrix(stub.baseUrl, {
        target: `stub-${fault}`,
        stabilizeMs: 0,
        quiet: true,
      });
      const seen = new Set(result.rounds.flatMap((r) => r.samples.map((s) => s.classification)));
      const ok =
        (result.reproduced === "REPRODUCED") === want.reproduced &&
        want.classes.every((klass) => seen.has(klass as never)) &&
        (fault !== "honest" || result.correlationRoute === "present");

      evidence.negativeControls[fault] =
        `${result.reproduced}; ${result.anomalies} anomalous of ${result.requestsIssued}; classes ${[...seen].join(",") || "none"}`;
      check(
        fault === "honest"
          ? "positive control: the honest stub passes the whole matrix with 0 anomalies"
          : `negative control "${fault}": the matrix fails and classifies it as ${want.classes.join("/")}`,
        ok,
        evidence.negativeControls[fault],
      );
    } finally {
      await stub.stop();
    }
  }

  check(
    "a matrix cannot exceed its request budget",
    await (async () => {
      const stub = await startFaultStub("honest");

      try {
        await runConcurrencyMatrix(stub.baseUrl, {
          target: "stub-budget",
          stabilizeMs: 0,
          quiet: true,
          requestBudget: 20,
        });

        return false;
      } catch (error) {
        return /request budget of 20 exhausted/.test(String(error)) && stub.requests() <= 20;
      } finally {
        await stub.stop();
      }
    })(),
  );
}

// ---------------------------------------------------------------------------

async function readyThenMatrix(
  name: string,
  baseUrl: string,
  readiness: Parameters<typeof awaitFullStackReady>[1],
): Promise<void> {
  const state = await awaitFullStackReady(baseUrl, readiness);

  check(`${name}: the page, the controller and a fresh Chromium context are ready`, state.ready);
  if (!state.ready) {
    console.log(
      `${name}: readiness not reached: ${JSON.stringify(state.page.notReady.slice(0, 3))}`,
    );
    evidence.verdicts[name] = "NO-GO (not ready; no matrix run)";

    return;
  }

  const result = await runConcurrencyMatrix(baseUrl, { target: name, stabilizeMs });

  evidence.matrices.push(result);
  evidence.verdicts[name] = result.verdict;
}

async function main(): Promise<void> {
  classifierControls();
  await faultControls();

  const local = targets.filter((t) => t === "node" || t === "workerd");
  const servers: RunningServer[] = [];
  const tmpRoot = mkdtempSync(join(tmpdir(), "strata-cf-concurrency-"));

  try {
    if (local.length > 0 && failureCount() === 0) {
      const consumerDir = join(tmpRoot, "consumer");
      const emptyNpmrc = join(tmpRoot, "empty.npmrc");
      const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");

      writeFileSync(emptyNpmrc, "");
      writeFileSync(emptyGlobalNpmrc, "");

      const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);

      for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"])
        delete env[name];

      section("Local candidate: three source-packed packages, external install");

      const install = installFullStackConsumer({
        tmpRoot,
        consumerDir,
        env,
        time: (_, work) => work(),
      });

      check("the packed candidate installs externally", install.ok);
      evidence.candidate = {
        kind: "SOURCE-PACKED CANDIDATE",
        checkout: evidence.checkoutSha,
        tuple: install.tuple,
        tarballs: Object.fromEntries(
          [...install.tarballs.entries()].map(([name, tarball]) => [name, tarball.sha256]),
        ),
      };

      const vite = (extra: NodeJS.ProcessEnv = {}) =>
        run(
          process.execPath,
          [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"],
          { cwd: consumerDir, env: { ...env, ...extra } },
        );
      const clean = (): void => {
        for (const dir of ["dist", "src/generated", ".nitro", ".angular"])
          rmSync(join(consumerDir, dir), { recursive: true, force: true });
      };
      const local_ = { attempts: 30, intervalMs: 500, httpConsecutive: 2, browserConsecutive: 1 };

      if (install.ok && local.includes("node")) {
        clean();
        must(vite(), "consumer `vite build` (node-server)");

        const node = await startNodeServer(consumerDir, env);

        servers.push(node);
        await readyThenMatrix("node", node.baseUrl, local_);
        await node.stop();
        servers.length = 0;
      }

      if (install.ok && local.includes("workerd")) {
        clean();
        must(
          vite({ BUILD_PRESET: "cloudflare-pages" }),
          "consumer `vite build` (cloudflare-pages)",
        );

        const wrangler = await startWrangler(consumerDir, env, "/products/42");

        servers.push(wrangler);
        await readyThenMatrix("workerd", wrangler.baseUrl, local_);
        check(
          "workerd: no code-generation or JIT error in the runtime log",
          !/Code generation from strings disallowed|JIT compilation|needs to be compiled using the JIT/.test(
            sanitize(wrangler.output()),
          ),
        );
        await wrangler.stop();
        servers.length = 0;
      }
    }

    if (targets.includes("deployed") && givenUrl) {
      section(`Existing deployment (read-only): ${givenUrl}`);

      // The deployment is only read. Its identity is whatever it was deployed from; it is NOT
      // assumed to be this checkout.
      const home = await fetch(givenUrl, { signal: AbortSignal.timeout(30_000) }).catch(
        () => undefined,
      );

      check(
        `the deployment still exists and answers (${home?.status ?? "no response"})`,
        home?.status === 200,
      );
      evidence.deployedArtifact = {
        url: givenUrl,
        probedStatus: home?.status ?? null,
        note: "artifact identity is NOT verified by this run; compare with the evidence of the run that deployed it",
        checkoutOfThisRun: evidence.checkoutSha,
      };
      if (home?.status === 200)
        await readyThenMatrix("deployed", givenUrl, {
          attempts: 40,
          intervalMs: 2_000,
          httpConsecutive: 5,
          browserConsecutive: 3,
        });
      else evidence.verdicts["deployed"] = "NOT RUN (deployment unreachable)";
    }
  } finally {
    await Promise.allSettled(servers.map((server) => server.stop()));
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  const negativesOk = failureCount() === 0 || Object.keys(evidence.negativeControls).length === 0;

  for (const name of ["node", "workerd", "deployed"] as const)
    if (!(name in evidence.verdicts))
      evidence.verdicts[name] = targets.includes(name) ? "NO-GO (did not complete)" : "NOT RUN";

  evidence.verdicts["negative controls"] = negativesOk ? "GO" : "NO-GO";
  section("Verdicts (diagnostic only; not the release qualification)");
  for (const [name, verdict] of Object.entries(evidence.verdicts))
    console.log(`${name}: ${verdict}`);
  console.log(
    "root cause of the historical anomaly: UNCONFIRMED (this diagnostic cannot confirm a historical cause)",
  );
  writeEvidence();

  if (failureCount() > 0) {
    console.error(`\nFAIL: ${TITLE} — ${failureCount()} failing check(s).`);
    process.exit(1);
  }
  console.log(`\nPASS: ${TITLE}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  writeEvidence();
  process.exit(1);
});
