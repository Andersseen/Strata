import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";

import { runConcurrencyMatrix } from "./lib/concurrency-matrix.ts";
import type { MatrixResult } from "./lib/concurrency-matrix.ts";
import {
  FULL_STACK_SERVER_SOURCES,
  PRIVATE_CANARIES,
  SERVER_ONLY_MARKERS,
} from "./lib/full-stack-fixture.ts";
import {
  ANALOG,
  CORE,
  FULL_STACK_PACKAGES,
  NOT_SOURCE,
  SERVER_COMPONENTS,
  installFullStackConsumer,
  must,
  Abort,
  sanitize,
} from "./lib/full-stack-install.ts";
import {
  awaitFullStackReady,
  concurrencySuite,
  diagnosedOpener,
  observeLimitations,
  surfaceSuite,
} from "./lib/full-stack-remote.ts";
import type { FullStackReadiness, FullStackRound, Observation } from "./lib/full-stack-remote.ts";
import {
  documentsSuite,
  httpSuite,
  islandSuite,
  navigationSuite,
  reloadSuite,
} from "./lib/full-stack-verify.ts";
import { check, failureCount, repoRoot, section } from "./lib/harness.ts";
import { isNodeBuiltin, moduleGraph } from "./lib/module-graph.ts";
import { isolatedEnv, restoreDir, snapshotDiffers, startWrangler } from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";
import { deployToPages } from "./lib/pages-deploy.ts";
import { COMPATIBILITY_DATE } from "./lib/wrangler.ts";

/**
 * `pnpm test:full-stack-deployed-cloudflare`: the complete Strata full-stack path
 * (@strata-sc/core + @strata-sc/analog + @strata-sc/server-components) on Cloudflare Pages
 * (docs/research/full-stack-deployed-cloudflare.md).
 *
 *   PHASE 1  LOCAL BUILD (always)   pack the three packages from this checkout, install ONLY the
 *            tarballs into tests/full-stack-package-consumer/fixture outside the workspace,
 *            build with BUILD_PRESET=cloudflare-pages, inspect the dependency and module graphs.
 *   PHASE 2  LOCAL WORKERD REHEARSAL (always)   the black-box verifier against `wrangler pages dev`.
 *            It proves the verifier; it is NOT a deployment and is never reported as one.
 *   PHASE 3  REAL PUBLIC DEPLOYMENT (explicit only)   deploy the already-qualified build and verify
 *            the public HTTPS URL:
 *              STRATA_FULLSTACK_DEPLOY=1             deploy to the isolated Pages project
 *                                                    (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
 *              STRATA_FULLSTACK_DEPLOYED_URL=https://…  verify an existing deployment of that project
 *            Without either: "REAL DEPLOYMENT: NOT RUN", never success.
 *
 * Environment:
 *   STRATA_FULLSTACK_PAGES_PROJECT      only "strata-fullstack-qualification" is accepted
 *   STRATA_FULLSTACK_REQUIRE_DEPLOYED=1 a missing/skipped/failed real deployment fails the run
 *   STRATA_FULLSTACK_EVIDENCE_FILE      write the structured result as JSON
 *   STRATA_FULLSTACK_DIAGNOSTICS_DIR    failure-only Chromium screenshots and traces
 *   STRATA_KEEP_CONSUMER=1              keep the temp app
 *
 * The candidate is SOURCE-PACKED: built from this checkout, not from the npm registry. It never
 * publishes, never touches npm dist-tags, `strata-www`, `strata-sc-qualification`, DNS, routes or bindings,
 * and never prints a credential.
 */

const TITLE = "full-stack deployed Cloudflare qualification";
const PROJECT = "strata-fullstack-qualification";
const WORKER_DIR = "analog/public/_worker.js";
const CANDIDATE = "SOURCE-PACKED CANDIDATE";

/** A deployment is ready after this many correct answers in a row. */
const READINESS = { attempts: 40, intervalMs: 2_000, httpConsecutive: 5, browserConsecutive: 3 };

const env_ = (name: string): string | undefined => process.env[name]?.trim() || undefined;

const project = env_("STRATA_FULLSTACK_PAGES_PROJECT") ?? PROJECT;
const wantDeploy = env_("STRATA_FULLSTACK_DEPLOY") === "1";
const givenUrl = env_("STRATA_FULLSTACK_DEPLOYED_URL")?.replace(/\/+$/, "");
const requireDeployed = env_("STRATA_FULLSTACK_REQUIRE_DEPLOYED") === "1";
const diagnosticsDir = env_("STRATA_FULLSTACK_DIAGNOSTICS_DIR");

if (project !== PROJECT) {
  console.error(
    `${TITLE}: refusing Pages project "${project}": only the isolated "${PROJECT}" may be deployed to (never strata-www or strata-sc-qualification).`,
  );
  process.exit(2);
}
if (wantDeploy && givenUrl) {
  console.error(
    `${TITLE}: set STRATA_FULLSTACK_DEPLOY or STRATA_FULLSTACK_DEPLOYED_URL, not both.`,
  );
  process.exit(2);
}
if (givenUrl && !new RegExp(`^https://([a-z0-9-]+\\.)?${PROJECT}\\.pages\\.dev$`).test(givenUrl)) {
  console.error(
    `${TITLE}: STRATA_FULLSTACK_DEPLOYED_URL must be an https origin of ${PROJECT}.pages.dev, got "${givenUrl}".`,
  );
  process.exit(2);
}

/** Credentials exist only in `deployEnv`; every other command (install, build, tests) runs without them. */
const credentials = {
  token: process.env["CLOUDFLARE_API_TOKEN"],
  account: process.env["CLOUDFLARE_ACCOUNT_ID"],
};
const secrets = [credentials.token, credentials.account, process.env["CLOUDFLARE_API_KEY"]].filter(
  (value): value is string => !!value && value.length > 3,
);
const redact = (text: string): string =>
  secrets.reduce((out, secret) => out.split(secret).join("***"), sanitize(text));

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-full-stack-deployed-"));
const consumerDir = join(tmpRoot, "consumer");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);

for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"])
  delete env[name];

const servers: RunningServer[] = [];
const timings: string[] = [];
const time = <T>(label: string, work: () => T): T => {
  const started = performance.now();

  try {
    return work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};
const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const git = (...args: string[]): string => run("git", args, { cwd: repoRoot }).stdout.trim();

interface Verification {
  readonly baseUrl: string;
  readonly readiness: FullStackReadiness;
  readonly verdicts: Record<string, string>;
  readonly surface?: Awaited<ReturnType<typeof surfaceSuite>>;
  readonly concurrency?: readonly FullStackRound[];
  /** The controlled controller matrix (correlation ids, classified anomalies); bounded, functional only. */
  readonly concurrencyMatrix?: MatrixResult;
  readonly limitations?: readonly Observation[];
}

const evidence: {
  candidate: string;
  startingMainSha: string;
  checkoutSha: string;
  workflowRun?: string;
  runner: Record<string, string>;
  packages?: Record<string, unknown>;
  installed?: Record<string, string>;
  cloudflare?: Record<string, unknown>;
  graph?: Record<string, unknown>;
  rehearsal?: Verification;
  deployment?: Record<string, unknown>;
  deployed?: Verification;
  verdicts: Record<string, string>;
} = {
  candidate: CANDIDATE,
  startingMainSha: env_("STRATA_FULLSTACK_BASELINE_SHA") ?? git("rev-parse", "HEAD"),
  checkoutSha: git("rev-parse", "HEAD"),
  runner: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    location:
      process.env["GITHUB_ACTIONS"] === "true" ? "GitHub Actions ubuntu runner" : "local machine",
  },
  verdicts: {},
};

if (process.env["GITHUB_ACTIONS"] === "true" && process.env["GITHUB_RUN_ID"]) {
  evidence.workflowRun = `${process.env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${process.env["GITHUB_REPOSITORY"] ?? ""}/actions/runs/${process.env["GITHUB_RUN_ID"]}`;
}

function writeEvidence(): void {
  const file = env_("STRATA_FULLSTACK_EVIDENCE_FILE");

  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  const summary = env_("GITHUB_STEP_SUMMARY");

  if (summary) {
    const deployment = evidence.deployment;
    const lines = [
      "### Full-stack Strata on Cloudflare Pages",
      "",
      `- candidate: **${CANDIDATE}** (built from \`${evidence.checkoutSha.slice(0, 12)}\`; not a published release)`,
      ...Object.entries(evidence.verdicts).map(([name, verdict]) => `- ${name}: **${verdict}**`),
      ...(deployment
        ? [
            `- Pages project: \`${String(deployment["project"])}\``,
            `- deployed URL: ${String(deployment["url"])}`,
            `- deployment: \`${String(deployment["id"] ?? deployment["hash"])}\``,
          ]
        : []),
      ...(evidence.workflowRun ? [`- run: ${evidence.workflowRun}`] : []),
      "",
    ];

    appendFileSync(summary, `${lines.join("\n")}\n`);
  }
}

const digestOf = (root: string, files: readonly string[]): string => {
  const hash = createHash("sha256");

  for (const file of [...files].sort()) {
    hash.update(
      `${file}\0${createHash("sha256")
        .update(readFileSync(join(root, file)))
        .digest("hex")}\n`,
    );
  }

  return hash.digest("hex");
};

/** The whole black-box verification of one base URL; the same for workerd and the public edge. */
async function verify(
  base: string,
  label: string,
  readiness: FullStackReadiness,
  options: { log?: () => string; surface: boolean },
): Promise<Verification> {
  const open = (name: string) => diagnosedOpener(`${label}-${name}`, diagnosticsDir);
  const http = await httpSuite(base, label, {
    lifecycle: false,
    ...(options.log ? { log: options.log } : {}),
  });
  const documents = await documentsSuite(base, label);
  const island = await islandSuite(base, label, open("island"));
  const navigation = await navigationSuite(base, label, open("navigation"));
  const reload = await reloadSuite(base, label, open("reload"));
  const before = failureCount();
  const surface = await surfaceSuite(base, label);
  const confidentiality = failureCount() === before;
  const mark = failureCount();
  const concurrency = await concurrencySuite(base);
  const matrix = await runConcurrencyMatrix(base, {
    target: label,
    // Only a public URL needs the stabilization interval; a loopback server has nothing to settle.
    stabilizeMs: label === "workerd" ? 0 : 10_000,
  });
  const concurrent = failureCount() === mark;
  const limitations = await observeLimitations(base);

  for (const observation of limitations) {
    console.log(
      `known limitation observed: ${observation.name} → ${observation.status} ${observation.contentType} (${observation.note})`,
    );
  }

  const verdict = (ok: boolean): string => (ok ? "GO" : "NO-GO");
  const all = (list: readonly boolean[]): boolean => list.every(Boolean);

  return {
    baseUrl: base,
    readiness,
    surface,
    concurrency,
    concurrencyMatrix: matrix,
    limitations,
    verdicts: {
      "controller integration": verdict(all(http.controller)),
      "Server Component SSR": verdict(all([...http.serverComponents, ...documents])),
      "interactive island": verdict(all([...island.ok, ...navigation, ...reload])),
      confidentiality: verdict(confidentiality && all(island.ok.slice(-5))),
      "bounded concurrency": verdict(concurrent),
    },
  };
}

async function main(): Promise<void> {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");

  // ------------------------------------------------------------------------
  section(`PHASE 1 — LOCAL BUILD: ${CANDIDATE} (three packed packages, external install)`);

  const install = installFullStackConsumer({ tmpRoot, consumerDir, env, time });

  check(
    "the packed candidate installs externally (tarballs, lock, single copies, entry points)",
    install.ok,
  );

  evidence.packages = {
    packedFrom: `checkout ${evidence.checkoutSha}`,
    notes: "pnpm pack of this checkout; NOT the npm registry packages",
    ...Object.fromEntries(
      install.manifests.map(({ pkg, manifest }) => [
        pkg.name,
        {
          version: manifest.version,
          tarball: install.tarballs.get(pkg.name)?.path.split("/").pop(),
          sha256: install.tarballs.get(pkg.name)?.sha256,
          integrity: install.tarballs.get(pkg.name)?.integrity,
        },
      ]),
    ),
  };
  evidence.installed = { ...install.tuple, node: process.version };
  console.log(`candidate: ${CANDIDATE}`);
  console.log(`packages: ${JSON.stringify(evidence.packages)}`);

  check(
    "the candidate is exactly @strata-sc/{core,analog,server-components}",
    FULL_STACK_PACKAGES.map((p) => p.name).join() ===
      [CORE.name, ANALOG.name, SERVER_COMPONENTS.name].join(),
  );

  const vite = (extraEnv: NodeJS.ProcessEnv = {}) =>
    run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"], {
      cwd: consumerDir,
      env: { ...env, ...extraEnv },
    });
  const clean = (): void => {
    for (const dir of ["dist", "src/generated", ".nitro", ".angular"])
      rmSync(join(consumerDir, dir), { recursive: true, force: true });
  };
  const cloudflareEnv = { BUILD_PRESET: "cloudflare-pages" };

  // The build-time server-only firewall, from the installed plugin, on the Cloudflare build.
  const island = join(consumerDir, "src", "app", "products", "product-availability.component.ts");

  clean();
  writeFileSync(
    island,
    `import { ProductRepository } from "./product.repository";\n${readFileSync(
      island,
      "utf8",
    ).replace(
      "protected readonly marker = CLIENT_MARKER;",
      "protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = ProductRepository.name;",
    )}`,
  );

  const illegal = vite(cloudflareEnv);
  const illegalOutput = sanitize(`${illegal.stdout}\n${illegal.stderr}`);

  check(
    "an island importing the server-only repository fails the Cloudflare production build, naming the importer",
    illegal.status !== 0 &&
      /\[strata\] Server-only module entered the browser graph: src\/app\/products\/product\.repository\.ts/.test(
        illegalOutput,
      ) &&
      /Imported from: src\/app\/products\/product-availability\.component\.ts/.test(illegalOutput),
    illegalOutput.slice(-400),
  );
  check(
    "the diagnostic prints no private value and no repository path",
    PRIVATE_CANARIES.every((c) => !illegalOutput.includes(c)) && !illegalOutput.includes(repoRoot),
  );
  restoreDir(consumerDir, install.pristine, NOT_SOURCE);
  clean();
  check(
    "the consumer sources are back to their original bytes",
    snapshotDiffers(consumerDir, install.pristine, NOT_SOURCE).length === 0,
  );

  // The candidate build.
  section("PHASE 1 — LOCAL BUILD: Cloudflare Pages production build and graph inspection");
  time("cloudflare-pages build", () =>
    must(vite(cloudflareEnv), "consumer `BUILD_PRESET=cloudflare-pages vite build`"),
  );

  const nitroPath = dist("analog", "nitro.json");
  const nitro = existsSync(nitroPath)
    ? (JSON.parse(readFileSync(nitroPath, "utf8")) as {
        preset?: string;
        versions?: { nitro?: string };
      })
    : {};
  const workerDir = dist(WORKER_DIR);
  const worker = moduleGraph(workerDir, "index.js");
  const workerFiles = worker.modules.map((module) => join(WORKER_DIR, module));
  const publicRoot = dist("analog", "public");
  const publicAssets = listFiles(publicRoot).filter((file) => !file.startsWith("_worker.js/"));
  const read = (file: string): string => readFileSync(dist(file), "utf8");
  const publicWith = (needle: string): string[] =>
    publicAssets.filter((file) => readFileSync(join(publicRoot, file), "utf8").includes(needle));
  const builtins = worker.externals.filter((external) => isNodeBuiltin(external.specifier));

  check(
    "Nitro resolved the cloudflare-pages preset",
    nitro.preset === "cloudflare-pages",
    String(nitro.preset),
  );
  check(
    "the Worker entry dist/analog/public/_worker.js/index.js exists",
    existsSync(join(workerDir, "index.js")),
  );
  check(
    "public client assets exist",
    publicAssets.some((f) => f.endsWith(".js")),
  );
  check("no node-server output (dist/analog/server) is left", !existsSync(dist("analog/server")));
  check(
    "the reachable Worker graph imports no Node built-in (nodejs_compat is not needed or enabled)",
    worker.modules.length > 0 && builtins.length === 0,
    builtins.map((b) => b.specifier).join(", "),
  );
  for (const marker of SERVER_ONLY_MARKERS) {
    check(
      `${marker}: present in the Worker graph (positive control)`,
      workerFiles.some((file) => read(file).includes(marker)),
    );
  }
  for (const marker of PRIVATE_CANARIES) {
    check(
      `${marker}: absent from every public asset`,
      publicWith(marker).length === 0,
      publicWith(marker).join(", "),
    );
  }
  check(
    "the controller is in the Worker graph and not in any public asset",
    workerFiles.some((file) => read(file).includes("ProductsController")) &&
      publicWith("ProductsController").length === 0 &&
      publicWith("registerControllers").length === 0,
  );
  check(
    "the client island is in the public browser assets",
    publicAssets.some(
      (file) =>
        file.endsWith(".js") &&
        readFileSync(join(publicRoot, file), "utf8").includes("FULLSTACK_CONSUMER_CLIENT_MARKER"),
    ),
  );

  const maps = publicAssets.filter((file) => file.endsWith(".map"));
  const mapSources = maps.flatMap(
    (file) =>
      (JSON.parse(readFileSync(join(publicRoot, file), "utf8")) as { sources?: string[] })
        .sources ?? [],
  );

  check(
    "public source maps exist, list the island, and name no server file, @strata-sc/core or @strata-sc/analog",
    maps.length > 0 &&
      mapSources.some((s) => s.endsWith("product-availability.component.ts")) &&
      !mapSources.some(
        (source) =>
          FULL_STACK_SERVER_SOURCES.some(
            (file) => source.endsWith(file) && !source.includes("/generated/"),
          ) || /@strata-sc\/(core|analog)\/|\/src\/server\//.test(source),
      ),
    `${maps.length} maps`,
  );

  const wranglerVersion = sanitize(
    run(
      process.execPath,
      [join(consumerDir, "node_modules", "wrangler", "bin", "wrangler.js"), "--version"],
      {
        cwd: consumerDir,
        env,
      },
    ).stdout,
  ).trim();
  const routesFile = ["analog/_routes.json", "analog/public/_routes.json"].find((f) =>
    existsSync(dist(f)),
  );

  evidence.cloudflare = {
    preset: nitro.preset,
    nitro: nitro.versions?.nitro,
    nitropack: install.tuple["nitropack"],
    wrangler: wranglerVersion,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: [],
    buildOutputDirectory: "dist/analog/public",
    workerEntry: "dist/analog/public/_worker.js/index.js",
    routes: routesFile
      ? (() => {
          const parsed = JSON.parse(read(routesFile)) as { include?: string[]; exclude?: string[] };

          return {
            file: routesFile,
            include: parsed.include,
            excludeCount: parsed.exclude?.length ?? 0,
          };
        })()
      : "(none)",
    buildDigestSha256: digestOf(publicRoot, listFiles(publicRoot)),
    buildFiles: listFiles(publicRoot).length,
    workerDigestSha256: digestOf(workerDir, listFiles(workerDir)),
  };
  evidence.graph = {
    workerModules: worker.modules.length,
    workerExternals: worker.externals.map((e) => e.specifier),
    nodeBuiltinsInWorker: builtins.length,
    publicAssets: publicAssets.length,
    publicSourceMaps: maps.length,
  };
  console.log(`cloudflare: ${JSON.stringify(evidence.cloudflare)}`);

  const phase1 = failureCount();

  evidence.verdicts["External source-packed consumer"] = install.ok ? "GO" : "NO-GO";
  evidence.verdicts["Full-stack Cloudflare build"] = phase1 === 0 ? "GO" : "NO-GO";

  // ------------------------------------------------------------------------
  if (phase1 === 0) {
    section(
      "PHASE 2 — LOCAL WORKERD REHEARSAL: the same verification against `wrangler pages dev` (NOT a deployment)",
    );

    const local = await startWrangler(consumerDir, env, "/products/42");

    servers.push(local);

    const readiness = await awaitFullStackReady(local.baseUrl, {
      attempts: 30,
      intervalMs: 500,
      httpConsecutive: 2,
      browserConsecutive: 1,
    });

    check(
      "local workerd serves the page, the controller and a fresh Chromium context",
      readiness.ready,
    );
    if (readiness.ready) {
      evidence.rehearsal = await verify(local.baseUrl, "workerd", readiness, {
        log: () => local.output(),
        surface: true,
      });
    }
    check(
      "workerd: no code-generation or JIT error in the runtime log",
      !/Code generation from strings disallowed|JIT compilation|needs to be compiled using the JIT/.test(
        sanitize(local.output()),
      ),
    );
    await local.stop();
    servers.length = 0;
    evidence.verdicts["Local workerd rehearsal (not a deployment)"] =
      failureCount() === phase1 ? "GO" : "NO-GO";
  } else {
    evidence.verdicts["Local workerd rehearsal (not a deployment)"] =
      "NOT RUN (local build failed)";
  }

  // ------------------------------------------------------------------------
  const phase2 = failureCount();
  let deployedUrl = givenUrl;
  let source = givenUrl ? "supplied URL (not deployed by this run)" : "";

  if (wantDeploy && phase2 > 0) {
    evidence.verdicts["Real public Cloudflare deployment"] =
      "NOT RUN (local qualification failed; nothing deployed)";
  } else if (wantDeploy) {
    section(`PHASE 3 — REAL PUBLIC DEPLOYMENT: wrangler pages deploy → ${project}`);

    if (!credentials.token || !credentials.account) {
      check(
        "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set (values never printed)",
        false,
        `missing: ${[!credentials.token && "CLOUDFLARE_API_TOKEN", !credentials.account && "CLOUDFLARE_ACCOUNT_ID"].filter(Boolean).join(", ")}`,
      );
      evidence.verdicts["Real public Cloudflare deployment"] =
        "NOT RUN (missing Cloudflare credentials)";
    } else {
      // Declarative config for the isolated project: no flags, no bindings.
      writeFileSync(
        join(consumerDir, "wrangler.jsonc"),
        `${JSON.stringify(
          {
            name: project,
            pages_build_output_dir: "./dist/analog/public",
            compatibility_date: COMPATIBILITY_DATE,
          },
          null,
          2,
        )}\n`,
      );

      const branch = `qualification-${evidence.checkoutSha.slice(0, 12)}`;
      const deployment = deployToPages({
        consumerDir,
        env: {
          ...env,
          CLOUDFLARE_API_TOKEN: credentials.token,
          CLOUDFLARE_ACCOUNT_ID: credentials.account,
        },
        project,
        branch,
        outputDirectory: "dist/analog/public",
        redact,
      });

      check(
        `the isolated Pages project ${project} exists or was created, and wrangler pages deploy reported its URL`,
        deployment.ok && !!deployment.url,
        deployment.output,
      );
      if (deployment.ok && deployment.url) {
        deployedUrl = deployment.url;
        source = `wrangler pages deploy (project ${project}, branch ${branch})`;
        evidence.deployment = {
          project,
          branch,
          projectCreatedByThisRun: deployment.created,
          url: deployment.url,
          hash: deployment.hash,
          ...(deployment.id ? { id: deployment.id } : {}),
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: [],
          buildDigestSha256: evidence.cloudflare["buildDigestSha256"],
        };
        console.log(`deployed: ${deployment.url}`);
      } else {
        evidence.verdicts["Real public Cloudflare deployment"] = "NO-GO (deploy failed)";
      }
    }
  }

  if (deployedUrl) {
    section(`PHASE 3 — REAL PUBLIC VERIFICATION: ${deployedUrl} (${source})`);

    const before = failureCount();
    const readiness = await awaitFullStackReady(deployedUrl, READINESS);

    check(
      `the public URL serves the Server Component page and the controller ${READINESS.httpConsecutive} times in a row, and fresh Chromium contexts ${READINESS.browserConsecutive} times (page attempt ${readiness.page.attempts}, ${readiness.page.notReady.length} not-ready; api attempt ${readiness.api.attempts}, ${readiness.api.notReady.length} not-ready; browser ${readiness.browser?.notReady.length ?? "-"} not-ready)`,
      readiness.ready,
      JSON.stringify([readiness.page.notReady, readiness.api.notReady].map((l) => l.slice(0, 3))),
    );
    evidence.deployment ??= { url: deployedUrl, source };
    if (readiness.ready) {
      try {
        evidence.deployed = await verify(deployedUrl, "deployed", readiness, { surface: true });
      } catch (error) {
        check(
          "the deployed verification ran to completion",
          false,
          redact(String(error)).slice(0, 3000),
        );
      }
    } else {
      evidence.deployed = { baseUrl: deployedUrl, readiness, verdicts: {} };
    }

    const failed = failureCount() !== before;
    const verdicts = evidence.deployed?.verdicts ?? {};

    evidence.verdicts["Real public Cloudflare deployment"] = failed ? "NO-GO" : "GO";
    for (const name of [
      "controller integration",
      "Server Component SSR",
      "interactive island",
      "confidentiality",
    ]) {
      evidence.verdicts[`Deployed ${name}`] = verdicts[name] ?? "NO-GO";
    }
  } else if (!evidence.verdicts["Real public Cloudflare deployment"]) {
    evidence.verdicts["Real public Cloudflare deployment"] = "NOT RUN";
  }
  if (evidence.verdicts["Real public Cloudflare deployment"]?.startsWith("NOT RUN")) {
    for (const name of [
      "Deployed controller integration",
      "Deployed Server Component SSR",
      "Deployed interactive island",
      "Deployed confidentiality",
    ]) {
      evidence.verdicts[name] = "NOT RUN";
    }
    console.log("\nREAL DEPLOYMENT: NOT RUN");
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Abort)) {
    check(
      "the qualification ran to completion",
      false,
      redact(error instanceof Error ? (error.stack ?? error.message) : String(error)),
    );
  }
} finally {
  for (const server of servers) await server.stop().catch(() => undefined);
  console.log(`\ntimings: ${timings.join("; ")}`);
  if (env_("STRATA_KEEP_CONSUMER") === "1") console.log(`kept: ${tmpRoot}`);
  else rmSync(tmpRoot, { recursive: true, force: true });
}

if (requireDeployed && evidence.verdicts["Real public Cloudflare deployment"] !== "GO") {
  check(
    "a real deployment was qualified (STRATA_FULLSTACK_REQUIRE_DEPLOYED=1)",
    false,
    evidence.verdicts["Real public Cloudflare deployment"] ?? "not run",
  );
}

section("Verdicts");
for (const [name, verdict] of Object.entries(evidence.verdicts)) console.log(`${name}: ${verdict}`);
writeEvidence();

console.log(
  `\n${failureCount() === 0 ? "PASS" : "FAIL"}: ${TITLE} (${CANDIDATE}) — ${failureCount()} failing check(s).`,
);
process.exit(failureCount() === 0 ? 0 : 1);
