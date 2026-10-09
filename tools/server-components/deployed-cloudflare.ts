import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";
import { isExactVersion, resolveRegistryVersion } from "../release/lib/registry-version.ts";

import { MARKERS, SERVER_MARKERS } from "./lib/consumer-fixture.ts";
import { awaitReady, serverSourcesInMap, verifyDeployment } from "./lib/deployed.ts";
import type { DeployedVerification } from "./lib/deployed.ts";
import { check, failureCount, repoRoot, section } from "./lib/harness.ts";
import { isNodeBuiltin, moduleGraph } from "./lib/module-graph.ts";
import {
  installedManifest,
  isSymlinkAnywhere,
  isUnder,
  isolatedEnv,
  resolveFromConsumer,
  startWrangler,
} from "./lib/package-consumer.ts";
import type { RunningServer } from "./lib/package-consumer.ts";
import { COMPATIBILITY_DATE } from "./lib/wrangler.ts";

/**
 * `pnpm test:server-components:deployed-cloudflare`: qualifies the PUBLISHED
 * @strata-sc/server-components on Cloudflare Pages
 * (docs/research/server-component-deployed-cloudflare.md).
 *
 *   1. LOCAL BUILD QUALIFICATION (always): the exact registry version is installed
 *      with npm into a fresh app outside the repository, built with Nitro's
 *      `cloudflare-pages` preset, and the Worker/browser graphs are scanned.
 *   2. LOCAL WORKERD REHEARSAL (no deployment target): the same black-box
 *      verification used for the real thing, against `wrangler pages dev`. It
 *      proves the verifier; it is NOT a deployment and is never reported as one.
 *   3. REAL DEPLOYMENT QUALIFICATION, only when explicitly requested:
 *        STRATA_SC_DEPLOY=1            deploy the build to the isolated Pages project
 *                                      (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
 *        STRATA_SC_DEPLOYED_URL=https://…  verify an existing https deployment instead
 *      Without either, the result is "NOT RUN", never success.
 *
 * Environment:
 *   STRATA_SC_REGISTRY_VERSION     exact version (default: packages/server-components/package.json)
 *   STRATA_SC_PAGES_PROJECT        Pages project (default and required prefix: strata-sc-qualification)
 *   STRATA_SC_REQUIRE_DEPLOYED=1   a missing/skipped deployment fails the run
 *   STRATA_SC_EVIDENCE_FILE        write the structured result as JSON
 *   STRATA_KEEP_CONSUMER=1         keep the temp app
 *
 * It never publishes to npm, never touches `strata-www`, DNS, routes or bindings,
 * and never prints a credential.
 */

const TITLE = "server-component deployed Cloudflare qualification";
const PACKAGE = "@strata-sc/server-components";
const REGISTRY = "https://registry.npmjs.org";
const PROJECT_PREFIX = "strata-sc-qualification";
const WORKER_DIR = "analog/public/_worker.js";

const env_ = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const sanitize = (text: string): string => stripVTControlCharacters(text);

const manifestVersion = (
  JSON.parse(readFileSync(join(repoRoot, "packages/server-components/package.json"), "utf8")) as {
    version: string;
  }
).version;
const version = (() => {
  try {
    return resolveRegistryVersion(env_("STRATA_SC_REGISTRY_VERSION"), manifestVersion);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
})();
const project = env_("STRATA_SC_PAGES_PROJECT") ?? PROJECT_PREFIX;
const wantDeploy = env_("STRATA_SC_DEPLOY") === "1";
const givenUrl = env_("STRATA_SC_DEPLOYED_URL")?.replace(/\/+$/, "");
const requireDeployed = env_("STRATA_SC_REQUIRE_DEPLOYED") === "1";

if (!isExactVersion(version)) {
  console.error(`${TITLE}: STRATA_SC_REGISTRY_VERSION must be an exact version, got "${version}".`);
  process.exit(2);
}
if (project !== PROJECT_PREFIX && !project.startsWith(`${PROJECT_PREFIX}-`)) {
  console.error(
    `${TITLE}: refusing project "${project}": only ${PROJECT_PREFIX}[-suffix] may be deployed to (never strata-www).`,
  );
  process.exit(2);
}
if (wantDeploy && givenUrl) {
  console.error(`${TITLE}: set STRATA_SC_DEPLOY or STRATA_SC_DEPLOYED_URL, not both.`);
  process.exit(2);
}
if (givenUrl && !/^https:\/\/[^/\s]+$/.test(givenUrl)) {
  console.error(`${TITLE}: STRATA_SC_DEPLOYED_URL must be an https origin, got "${givenUrl}".`);
  process.exit(2);
}
if (givenUrl && /^https:\/\/(localhost|127\.|\[::1\])/.test(givenUrl)) {
  console.error(`${TITLE}: STRATA_SC_DEPLOYED_URL must be a public host, not ${givenUrl}.`);
  process.exit(2);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-server-component-deployed-"));
const consumerDir = join(tmpRoot, "consumer");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
const fixtureTemplate = join(repoRoot, "tests", "server-component-package-consumer", "fixture");
const servers: RunningServer[] = [];

/** Strips credential values from anything printed. */
const secrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"]
  .map((name) => process.env[name])
  .filter((value): value is string => !!value && value.length > 3);
const redact = (text: string): string =>
  secrets.reduce((out, secret) => out.split(secret).join("***"), sanitize(text));

const npm = (args: readonly string[], cwd = tmpRoot) =>
  run("npm", [...args, "--registry", REGISTRY], { cwd, env });
const node = (script: string, args: readonly string[]) =>
  run(process.execPath, [join(consumerDir, "node_modules", script), ...args], {
    cwd: consumerDir,
    env,
  });
const installedVersionOf = (name: string): string =>
  installedManifest(consumerDir, name)?.version ?? "(not installed)";
const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);

interface Evidence {
  readonly package: string;
  readonly version: string;
  readonly baseline: string;
  versions?: Record<string, string>;
  dist?: { integrity?: string; tarball?: string } | undefined;
  cloudflare?: Record<string, unknown>;
  graph?: Record<string, unknown>;
  rehearsal?: DeployedVerification;
  deployment?: Record<string, unknown>;
  deployed?: DeployedVerification;
  verdicts: Record<string, string>;
}

const evidence: Evidence = {
  package: PACKAGE,
  version,
  baseline: run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim(),
  verdicts: {},
};

function writeEvidence(): void {
  const file = env_("STRATA_SC_EVIDENCE_FILE");

  if (file) writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);

  const summary = env_("GITHUB_STEP_SUMMARY");

  if (summary) {
    const lines = [
      `### Deployed Cloudflare qualification`,
      "",
      `- package: \`${PACKAGE}@${version}\` (installed from ${REGISTRY})`,
      ...Object.entries(evidence.verdicts).map(([name, verdict]) => `- ${name}: **${verdict}**`),
      ...(evidence.deployment
        ? [
            `- Pages project: \`${String(evidence.deployment["project"])}\``,
            `- deployed URL: ${String(evidence.deployment["url"])}`,
            `- deployment id: \`${String(evidence.deployment["id"])}\``,
          ]
        : []),
      "",
    ];

    appendFileSync(summary, `${lines.join("\n")}\n`);
  }
}

async function main(): Promise<void> {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");

  // ------------------------------------------------------------------------
  section("LOCAL BUILD QUALIFICATION — install the published package from npm");

  const view = npm(["view", `${PACKAGE}@${version}`, "version"]);

  if (view.status !== 0 || view.stdout.trim() !== version) {
    if (/E404/.test(view.stderr) && !requireDeployed) {
      console.log(
        `\nNOT APPLICABLE: ${PACKAGE}@${version} is not on ${REGISTRY} yet (e.g. a Version Packages PR).`,
      );
      evidence.verdicts["Local build"] = "NOT APPLICABLE (version not published)";
      evidence.verdicts["Real deployment"] = "NOT RUN";
      writeEvidence();

      return;
    }
    check(
      `${PACKAGE}@${version} is visible on ${REGISTRY}`,
      false,
      sanitize(view.stderr).slice(-500),
    );
    throw new Error("not published");
  }
  check(`${PACKAGE}@${version} is visible on ${REGISTRY}`, true);

  evidence.dist = JSON.parse(
    npm(["view", `${PACKAGE}@${version}`, "dist", "--json"]).stdout || "{}",
  ) as Evidence["dist"];
  console.log(`dist.integrity: ${evidence.dist?.integrity ?? "(missing)"}`);
  check("dist.integrity is present (sha512)", /^sha512-/.test(evidence.dist?.integrity ?? ""));

  check(
    "the consumer lives outside the repository",
    !realpathSync(tmpRoot).startsWith(realpathSync(repoRoot)),
  );
  cpSync(fixtureTemplate, consumerDir, { recursive: true });

  const manifestPath = join(consumerDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  manifest.dependencies[PACKAGE] = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const spec = JSON.stringify(manifest.dependencies[PACKAGE]);

  check(
    `the dependency is the exact version ${spec}: no workspace:, link:, file:, tarball or range`,
    manifest.dependencies[PACKAGE] === version && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version),
  );

  const install = npm(["install", "--no-audit", "--no-fund", "--loglevel=error"], consumerDir);

  if (!check("npm install exits 0", install.status === 0, sanitize(install.stderr).slice(-1500)))
    throw new Error("install failed");

  const installed = join(consumerDir, "node_modules", PACKAGE);

  check(
    `installed package.json version === ${version}`,
    installedVersionOf(PACKAGE) === version,
    installedVersionOf(PACKAGE),
  );
  check(
    "a real directory under consumer/node_modules, not a symlink",
    isUnder(realpathSync(installed), join(realpathSync(consumerDir), "node_modules")) &&
      !isSymlinkAnywhere(installed) &&
      lstatSync(installed).isDirectory(),
  );

  const resolved = resolveFromConsumer(
    consumerDir,
    [PACKAGE, `${PACKAGE}/vite`, `${PACKAGE}/server-only`],
    env,
  );

  for (const [specifier, url] of Object.entries(resolved))
    console.log(`resolve ${specifier} → ${url}`);
  check(
    "package exports (`.`, `/vite`, `/server-only`) resolve under consumer/node_modules, never the repository",
    Object.values(resolved).every(
      (url) =>
        isUnder(url, join(consumerDir, "node_modules")) &&
        !realpathSync(new URL(url)).startsWith(`${realpathSync(repoRoot)}/`),
    ),
  );

  const wranglerBin = join("wrangler", "bin", "wrangler.js");
  const wranglerVersion = sanitize(node(wranglerBin, ["--version"]).stdout).trim();

  evidence.versions = {
    [PACKAGE]: installedVersionOf(PACKAGE),
    "@angular/core": installedVersionOf("@angular/core"),
    "@analogjs/platform": installedVersionOf("@analogjs/platform"),
    vite: installedVersionOf("vite"),
    wrangler: wranglerVersion,
    typescript: installedVersionOf("typescript"),
    node: process.version,
  };
  console.log(`versions: ${JSON.stringify(evidence.versions)}`);

  // ------------------------------------------------------------------------
  section("LOCAL BUILD QUALIFICATION — Cloudflare Pages production build");

  const built = run(
    process.execPath,
    [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), "build"],
    { cwd: consumerDir, env: { ...env, BUILD_PRESET: "cloudflare-pages" } },
  );

  if (
    !check(
      "consumer `BUILD_PRESET=cloudflare-pages vite build` exits 0",
      built.status === 0,
      sanitize(built.stderr || built.stdout).slice(-2000),
    )
  )
    throw new Error("build failed");

  const nitroPath = dist("analog", "nitro.json");
  const nitro = existsSync(nitroPath)
    ? (JSON.parse(readFileSync(nitroPath, "utf8")) as {
        preset?: string;
        versions?: { nitro?: string };
      })
    : {};
  const entry = join(WORKER_DIR, "index.js");

  check(
    "Nitro resolved the cloudflare-pages preset",
    nitro.preset === "cloudflare-pages",
    String(nitro.preset),
  );
  check(
    `Worker entry dist/analog/public/_worker.js/index.js exists`,
    existsSync(dist("analog/public/_worker.js/index.js")),
  );
  check("no node-server output (dist/analog/server) left", !existsSync(dist("analog/server")));

  const routes = existsSync(dist("analog", "_routes.json"))
    ? readFileSync(dist("analog", "_routes.json"), "utf8")
    : existsSync(dist("analog/public/_routes.json"))
      ? readFileSync(dist("analog/public/_routes.json"), "utf8")
      : "(none)";

  evidence.cloudflare = {
    preset: nitro.preset,
    nitro: nitro.versions?.nitro,
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: [],
    buildOutputDirectory: "dist/analog/public",
    workerEntry: entry.replace(/^analog\/public\//, "dist/analog/public/"),
    routes: routes.replace(/\s+/g, " ").trim(),
  };
  console.log(`cloudflare: ${JSON.stringify(evidence.cloudflare)}`);

  // Worker graph and browser graph.
  const graph = moduleGraph(dist(WORKER_DIR), "index.js");
  const workerFiles = graph.modules.map((module) => join(WORKER_DIR, module));
  const browserFiles = ["client", "analog/public"].flatMap((dir) =>
    existsSync(dist(dir))
      ? listFiles(dist(dir))
          .map((file) => join(dir, file))
          .filter((file) => !file.startsWith(`${WORKER_DIR}/`))
      : [],
  );
  const read = (file: string): string => readFileSync(dist(file), "utf8");
  const withNeedle = (files: readonly string[], needle: string): string[] =>
    files.filter((file) => read(file).includes(needle));
  const builtins = graph.externals.filter((external) => isNodeBuiltin(external.specifier));

  console.log(
    `Worker graph: ${graph.modules.length} modules; browser graph: ${browserFiles.length} files`,
  );
  check("the reachable Worker graph is non-empty (positive control)", graph.modules.length > 0);
  check("the browser graph is non-empty (positive control)", browserFiles.length > 0);
  check(
    "the Worker graph imports nothing outside itself and no Node built-in (no nodejs_compat needed)",
    graph.externals.length === 0 && builtins.length === 0,
    graph.externals.map((e) => e.specifier).join(", "),
  );

  for (const marker of SERVER_MARKERS) {
    check(
      `${marker}: present in the Worker graph (positive control)`,
      withNeedle(workerFiles, marker).length > 0,
    );
    check(
      `${marker}: absent from every browser file`,
      withNeedle(browserFiles, marker).length === 0,
    );
  }
  check(
    `${MARKERS.client}: present in the browser graph`,
    withNeedle(
      browserFiles.filter((file) => file.endsWith(".js")),
      MARKERS.client,
    ).length > 0,
  );

  const maps = browserFiles.filter((file) => file.endsWith(".map"));
  const mapSources = maps.flatMap(
    (file) => (JSON.parse(read(file)) as { sources?: string[] }).sources ?? [],
  );

  check(
    "source maps exist in the browser graph (positive control)",
    maps.length > 0,
    `${maps.length}`,
  );
  check(
    "a browser source map lists the client island (positive control)",
    mapSources.some((source) => source.includes("add-to-cart.component.ts")),
  );
  check(
    "no browser source map lists or embeds a server-only source",
    serverSourcesInMap(mapSources).length === 0 &&
      maps.every((file) => SERVER_MARKERS.every((marker) => !read(file).includes(marker))),
  );

  evidence.graph = {
    workerModules: graph.modules.length,
    browserFiles: browserFiles.length,
    browserSourceMaps: maps.length,
    nodeBuiltinsInWorker: builtins.length,
  };

  const localFailures = failureCount();

  evidence.verdicts["Local build qualification"] = localFailures === 0 ? "GO" : "NO-GO";

  // ------------------------------------------------------------------------
  let deployedUrl = givenUrl;
  let deploymentSource = givenUrl ? "supplied URL (not deployed by this run)" : "";

  if (wantDeploy && localFailures > 0) {
    evidence.verdicts["Real deployment"] =
      "NOT RUN (local build qualification failed; nothing deployed)";
  } else if (wantDeploy) {
    section(`REAL DEPLOYMENT — wrangler pages deploy → ${project}`);

    const token = process.env["CLOUDFLARE_API_TOKEN"];
    const account = process.env["CLOUDFLARE_ACCOUNT_ID"];

    if (!token || !account) {
      check(
        "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are set (values never printed)",
        false,
        `missing: ${[!token && "CLOUDFLARE_API_TOKEN", !account && "CLOUDFLARE_ACCOUNT_ID"].filter(Boolean).join(", ")}`,
      );
      evidence.verdicts["Real deployment"] = "NOT RUN (missing Cloudflare credentials)";
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

      const created = node(wranglerBin, [
        "pages",
        "project",
        "create",
        project,
        "--production-branch",
        "main",
        "--compatibility-date",
        COMPATIBILITY_DATE,
      ]);
      const createdOut = redact(`${created.stdout}\n${created.stderr}`);

      check(
        `Pages project ${project} exists or was created`,
        created.status === 0 || createdOut.includes("A project with this name already exists"),
        createdOut.slice(-600),
      );

      const branch = `qualification-${version}`;
      const deploy = node(wranglerBin, [
        "pages",
        "deploy",
        "dist/analog/public",
        "--project-name",
        project,
        "--branch",
        branch,
        "--commit-dirty=true",
      ]);
      const deployOut = redact(`${deploy.stdout}\n${deploy.stderr}`);
      const urlMatch = new RegExp(
        `https://([a-z0-9]+)\\.${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.pages\\.dev`,
      ).exec(deployOut);

      check("wrangler pages deploy exits 0", deploy.status === 0, deployOut.slice(-800));
      check(
        "wrangler reported a deployment URL on the isolated project",
        !!urlMatch,
        deployOut.slice(-400),
      );

      if (deploy.status === 0 && urlMatch) {
        deployedUrl = urlMatch[0];
        deploymentSource = `wrangler pages deploy (project ${project}, branch ${branch})`;
        evidence.deployment = {
          project,
          branch,
          id: urlMatch[1],
          url: deployedUrl,
          idNote: "the deployment hash subdomain printed by wrangler",
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: [],
        };
        console.log(`deployed: ${deployedUrl}`);
      } else {
        evidence.verdicts["Real deployment"] = "NO-GO (deploy failed)";
      }
    }
  }

  // ------------------------------------------------------------------------
  if (deployedUrl) {
    section(`REAL DEPLOYMENT QUALIFICATION — ${deployedUrl} (${deploymentSource})`);

    const before = failureCount();
    const first = await awaitReady(deployedUrl);

    check(
      `the deployment answers 200 text/html on /product (attempt ${first.attempts}, ${first.readyAfterMs} ms)`,
      first.ready,
    );
    if (first.ready) {
      evidence.deployment ??= { url: deployedUrl, source: deploymentSource };
      try {
        evidence.deployed = await verifyDeployment(deployedUrl, first);
      } catch (error) {
        check(
          "the deployed verification ran to completion",
          false,
          redact(String(error)).slice(0, 600),
        );
      }
    }
    evidence.verdicts["Real deployment"] = failureCount() === before ? "GO" : "NO-GO";
  } else if (!evidence.verdicts["Real deployment"]) {
    // The rehearsal below runs against local workerd and says so; this stays NOT RUN.
    evidence.verdicts["Real deployment"] =
      "NOT RUN (no STRATA_SC_DEPLOY=1 with Cloudflare credentials, and no STRATA_SC_DEPLOYED_URL)";
  }

  // ------------------------------------------------------------------------
  if (!deployedUrl) {
    section(
      "LOCAL WORKERD REHEARSAL — the same verification against `wrangler pages dev` (NOT a deployment)",
    );

    const before = failureCount();
    const local = await startWrangler(consumerDir, env);

    servers.push(local);

    const first = await awaitReady(local.baseUrl, 30, 500);

    check("local workerd answers 200 text/html on /product", first.ready);
    if (first.ready) {
      try {
        evidence.rehearsal = await verifyDeployment(local.baseUrl, first);
      } catch (error) {
        check("the rehearsal verification ran to completion", false, String(error).slice(0, 600));
      }
    }
    await local.stop();
    servers.length = 0;
    evidence.verdicts["Local workerd rehearsal (not a deployment)"] =
      failureCount() === before ? "PASS" : "FAIL";
  }
}

try {
  await main();
} catch (error) {
  check(
    "the qualification ran to completion",
    false,
    redact(error instanceof Error ? error.message : String(error)),
  );
} finally {
  for (const server of servers) await server.stop().catch(() => undefined);
  if (env_("STRATA_KEEP_CONSUMER") === "1") console.log(`kept: ${tmpRoot}`);
  else rmSync(tmpRoot, { recursive: true, force: true });
}

if (requireDeployed && !evidence.verdicts["Real deployment"]?.startsWith("GO")) {
  check(
    "a real deployment was qualified (STRATA_SC_REQUIRE_DEPLOYED=1)",
    false,
    evidence.verdicts["Real deployment"] ?? "not run",
  );
}

section("Verdicts");
for (const [name, verdict] of Object.entries(evidence.verdicts)) console.log(`${name}: ${verdict}`);
writeEvidence();

console.log(
  `\n${failureCount() === 0 ? "PASS" : "FAIL"}: ${TITLE} (${PACKAGE}@${version}) — ${failureCount()} failing check(s).`,
);
process.exit(failureCount() === 0 ? 0 : 1);
