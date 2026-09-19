import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../consumer/lib/exec.ts";
import type { CommandResult } from "../consumer/lib/exec.ts";

import {
  CLIENT_MARKER,
  CORE_INTERNAL_SYMBOL,
  EXPECTED_HELLO_DEFINITION,
  EXPECTED_PROBE_DEFINITION,
  FIXTURE_PACKAGE,
  SERVER_MARKER,
} from "./lib/constants.ts";
import { fingerprintH3, lockfileVersions, requirePackage } from "./lib/graph.ts";
import type { ResolvedPackage } from "./lib/graph.ts";
import { findFreePort, httpGet, spawnManaged, waitForHttp } from "./lib/process.ts";
import type { ManagedProcess } from "./lib/process.ts";
import { renderReport } from "./lib/report.ts";
import type {
  AnalogReport,
  Arm,
  Check,
  CommandSummary,
  DependencyRow,
  H3Resolution,
  MarkerScan,
  Outcome,
  SeamSnapshot,
} from "./lib/report.ts";
import { findFilesContaining } from "./lib/scan.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "apps", "analog-fixture");
const distDir = join(fixtureDir, "dist");
const reportPath = join(repoRoot, "docs", "research", "analog-integration-baseline.md");
const previewArgs = ["dist/analog/server/index.mjs"];

const PROBE_TSCONFIG_ENV = "STRATA_ANALOG_PROBE_TSCONFIG";
const STANDARD_DECORATORS_TSCONFIG = "tsconfig.probe-standard.app.json";

/**
 * Verbatim first failure recorded on 2026-09-19, before `packageExtensions`
 * declared the H3 major Nitro 2 uses for `@analogjs/vite-plugin-nitro`.
 * (Absolute paths shortened to `<repo>`.)
 */
const PRE_WORKAROUND_FAILURE = `failed to load config from <repo>/apps/analog-fixture/vite.config.ts
error during build:
file://<repo>/node_modules/.pnpm/@analogjs+vite-plugin-nitro@2.7.2_…/node_modules/@analogjs/vite-plugin-nitro/src/lib/utils/register-dev-middleware.js:1
import { createEvent } from 'h3';
         ^^^^^^^^^^^
SyntaxError: The requested module 'h3' does not provide an export named 'createEvent'`;

/** Read from the npm registry on 2026-09-19. Not installed, built or run by this test. */
const UPSTREAM_METADATA = `| Line | \`@analogjs/platform\` | HTTP runtime it declares |
| --- | --- | --- |
| \`latest\` (this fixture) | 2.7.2 | \`nitropack ^2.13.1\` → \`h3 ^1.15.11\` |
| \`beta\` | 2.8.0-beta.5 | \`nitropack ^2.13.1\` |
| \`alpha\` | 3.0.0-alpha.87 | \`nitro 3.0.260903-beta\` and \`h3 ^2.0.1-rc.31\` |

The \`alpha\` line is the only one whose declared runtime is H3 v2 (same major as \`@strata/h3\`).
Whether that line exposes a compatible H3 app is **unverified**; this fixture did not run it.`;

const commands: CommandSummary[] = [];
const checks: Check[] = [];

/** Keeps machine-specific paths and per-run ports out of the committed report. */
function portable(command: string): string {
  return command
    .replaceAll(process.execPath, "node")
    .replaceAll(repoRoot, "<repo>")
    .replace(/--port \d+/, "--port <port>");
}

function record(label: string, result: CommandResult): CommandResult {
  commands.push({ label, command: portable(result.command), status: result.status });

  return result;
}

function recordServer(label: string, server: ManagedProcess): void {
  commands.push({ label, command: portable(server.command), status: null });
}

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${passed ? "" : ` — ${detail}`}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function excerpt(text: string, pattern: RegExp, maxLines = 4): string {
  const lines = text.split("\n").filter((line) => pattern.test(line));

  return lines
    .slice(0, maxLines)
    .map((line) => line.trim().replace(repoRoot, "<repo>"))
    .join(" / ");
}

function fixtureBuild(config?: string, env: NodeJS.ProcessEnv = {}): CommandResult {
  rmSync(distDir, { recursive: true, force: true });

  const args = ["exec", "vite", "build", ...(config ? ["--config", config] : [])];

  return run("pnpm", args, { cwd: fixtureDir, env: { ...process.env, ...env } });
}

async function withProductionServer<T>(
  label: string,
  action: (baseUrl: string, server: ManagedProcess) => Promise<T>,
): Promise<T> {
  const port = await findFreePort();
  const server = spawnManaged(process.execPath, previewArgs, {
    cwd: fixtureDir,
    env: { PORT: String(port), NITRO_PORT: String(port) },
  });

  try {
    const baseUrl = `http://localhost:${port}`;

    await waitForHttp(`${baseUrl}/api/native`, server, 30_000);

    return await action(baseUrl, server);
  } finally {
    await server.stop();
    recordServer(label, server);
  }
}

async function withDevServer<T>(
  label: string,
  config: { file?: string; env?: NodeJS.ProcessEnv },
  action: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const port = await findFreePort();
  const args = [
    "exec",
    "vite",
    "--port",
    String(port),
    "--strictPort",
    ...(config.file ? ["--config", config.file] : []),
  ];
  const server = spawnManaged("pnpm", args, { cwd: fixtureDir, env: config.env ?? {} });

  try {
    const baseUrl = `http://localhost:${port}`;

    await waitForHttp(`${baseUrl}/api/native`, server, 90_000);

    return await action(baseUrl);
  } finally {
    await server.stop();
    recordServer(label, server);
  }
}

async function getJson<T>(url: string): Promise<{ status: number; body: string; json: T | null }> {
  const result = await httpGet(url);

  try {
    const json = JSON.parse(result.body) as T;

    // Dev servers pretty-print JSON; compact it so both modes compare and read alike.
    return { status: result.status, body: JSON.stringify(json), json };
  } catch {
    return { status: result.status, body: result.body, json: null };
  }
}

interface StrataCoreBody {
  source?: string;
  definition?: unknown;
  invoked?: { message?: string; marker?: string };
}

interface NativeBody {
  source?: string;
}

interface SeamBody {
  snapshot?: SeamSnapshot | null;
}

interface RouteObservation {
  native: { status: number; body: string; ok: boolean };
  strataCore: { status: number; body: string; ok: boolean };
  seam: SeamSnapshot | null;
}

async function observeRoutes(baseUrl: string): Promise<RouteObservation> {
  const native = await getJson<NativeBody>(`${baseUrl}/api/native`);
  const strata = await getJson<StrataCoreBody>(`${baseUrl}/api/strata-core`);
  const seam = await getJson<SeamBody>(`${baseUrl}/api/seam`);

  return {
    native: {
      status: native.status,
      body: native.body,
      ok: native.status === 200 && native.json?.source === "analog",
    },
    strataCore: {
      status: strata.status,
      body: strata.body,
      ok:
        strata.status === 200 &&
        strata.json?.source === "strata-core" &&
        JSON.stringify(strata.json.definition) === JSON.stringify(EXPECTED_HELLO_DEFINITION) &&
        strata.json.invoked?.message === "Hello from Strata" &&
        strata.json.invoked.marker === SERVER_MARKER,
    },
    seam: seam.json?.snapshot ?? null,
  };
}

async function probePageObservation(
  baseUrl: string,
): Promise<{ status: number; ok: boolean; note: string }> {
  const result = await httpGet(`${baseUrl}/decorator-probe`);
  const rendered = result.body.includes(JSON.stringify(EXPECTED_PROBE_DEFINITION));

  return {
    status: result.status,
    ok: result.status === 200 && rendered,
    note: `HTTP ${result.status}; page ${rendered ? "rendered" : "did not render"} the expected definition`,
  };
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const baselineCommit = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout.trim();
  const arms: Arm[] = [];

  console.log("Preparing @strata/core (the fixture consumes its built dist)…");
  const coreBuild = record(
    "Build @strata/core",
    run("pnpm", ["--filter", "@strata/core", "run", "build"], { cwd: repoRoot }),
  );

  if (coreBuild.status !== 0) {
    throw new Error(`@strata/core failed to build:\n${coreBuild.stderr}`);
  }

  // ---- Dependency graph -------------------------------------------------
  console.log("Inspecting the resolved dependency graph…");
  const fixtureManifest = readJson<{
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }>(join(fixtureDir, "package.json"));
  const declared = { ...fixtureManifest.dependencies, ...fixtureManifest.devDependencies };

  const resolvedFromFixture = new Map<string, ResolvedPackage>();
  const dependencies: DependencyRow[] = [];
  const addDependency = (pkg: ResolvedPackage, declaredRange: string, note: string): void => {
    dependencies.push({
      name: pkg.name,
      declared: declaredRange,
      resolved: pkg.version,
      note,
    });
  };

  for (const [name, note] of [
    ["@angular/core", "Angular runtime"],
    ["@angular/compiler-cli", "Angular compiler (ngtsc)"],
    ["@angular/build", "Angular build tooling used by the Analog plugin"],
    ["@analogjs/platform", "Analog (Vite platform plugin)"],
    ["@analogjs/vite-plugin-angular", "Analog's Angular compiler integration"],
    ["@analogjs/router", "Analog file router"],
    ["vite", "Fixture-local Vite"],
    ["typescript", "TypeScript"],
    ["tslib", "TypeScript helper library"],
  ] as const) {
    const pkg = requirePackage(fixtureDir, name);

    resolvedFromFixture.set(name, pkg);
    addDependency(pkg, declared[name] ?? "(transitive)", note);
  }

  const platform = resolvedFromFixture.get("@analogjs/platform");
  const angularBuild = resolvedFromFixture.get("@angular/build");

  if (!platform || !angularBuild) throw new Error("Analog packages were not resolved.");

  const vitePluginNitro = requirePackage(platform.dir, "@analogjs/vite-plugin-nitro");
  const nitropack = requirePackage(vitePluginNitro.dir, "nitropack");

  addDependency(vitePluginNitro, "(transitive)", "Analog's Nitro integration");
  addDependency(nitropack, "(transitive)", "Nitro 2 — the HTTP runtime");
  addDependency(
    requirePackage(angularBuild.dir, "vite"),
    "(transitive)",
    "Vite bundled by @angular/build",
  );
  addDependency(
    requirePackage(fixtureDir, "@strata/core"),
    declared["@strata/core"] ?? "(transitive)",
    "workspace link",
  );

  const strataH3Dir = join(repoRoot, "packages", "h3");
  const strataH3Manifest = readJson<{ dependencies: Record<string, string> }>(
    join(strataH3Dir, "package.json"),
  );
  const strataH3 = requirePackage(strataH3Dir, "h3");
  const nitroH3 = requirePackage(nitropack.dir, "h3");
  const pluginH3 = requirePackage(vitePluginNitro.dir, "h3");

  addDependency(nitroH3, "^1.15.11", "H3 used by nitropack (Nitro 2)");
  addDependency(strataH3, strataH3Manifest.dependencies["h3"] ?? "?", "H3 used by @strata/h3");

  const h3Resolutions: H3Resolution[] = [];

  for (const [consumer, dir] of [
    ["`nitropack`", nitropack.dir],
    ["`@analogjs/vite-plugin-nitro`", vitePluginNitro.dir],
    ["`@strata/h3`", strataH3Dir],
  ] as const) {
    const resolved = requirePackage(dir, "h3");
    const fingerprint = await fingerprintH3(dir);

    h3Resolutions.push({
      consumer,
      version: resolved.version,
      createApp: fingerprint.createApp,
      createRouter: fingerprint.createRouter,
      createEvent: fingerprint.createEvent,
      H3: fingerprint.H3,
    });
  }

  const lockfile = [
    ...lockfileVersions(join(repoRoot, "pnpm-lock.yaml"), [
      "@analogjs/platform",
      "@angular/core",
      "@angular/build",
      "nitropack",
      "nitro",
      "h3",
      "vite",
      "rolldown",
      "typescript",
    ]),
  ].map(([name, versions]) => ({ name, versions }));

  if (!lockfile.some((row) => row.name === "nitro")) lockfile.push({ name: "nitro", versions: [] });

  lockfile.sort((a, b) => a.name.localeCompare(b.name));

  check(
    "Analog's Nitro plugin resolves the same H3 as nitropack",
    pluginH3.version === nitroH3.version && pluginH3.dir === nitroH3.dir,
    `plugin → ${pluginH3.version}, nitropack → ${nitroH3.version}`,
  );
  check(
    "Analog/Nitro run H3 v1 and @strata/h3 runs H3 v2",
    nitroH3.version.startsWith("1.") && strataH3.version.startsWith("2."),
    `nitropack → ${nitroH3.version}, @strata/h3 → ${strataH3.version}`,
  );
  check(
    "No Nitro 3 (`nitro` package) in the workspace graph",
    !lockfile.some((row) => row.name === "nitro" && row.versions.length > 0),
    "lockfile scan",
  );

  // ---- Arm G1: Angular-compiled graph, stock tsconfig (experimentalDecorators: true) ----
  console.log("Arm G1 — Angular-compiled graph, stock tsconfig…");
  const g1 = record(
    "G1 probe build (stock `experimentalDecorators: true`)",
    fixtureBuild("vite.probe.config.ts", { [PROBE_TSCONFIG_ENV]: "tsconfig.probe.app.json" }),
  );
  const g1CompileFailure =
    g1.status !== 0 &&
    /Unable to resolve signature of class decorator/.test(`${g1.stderr}${g1.stdout}`);
  const g1Diagnostics = excerpt(
    `${g1.stderr}\n${g1.stdout}`,
    /Unable to resolve signature|runtime will invoke/,
  );

  arms.push({
    id: "G1",
    pipeline: "Angular-compiled graph (page → controller)",
    mode: "production build, stock tsconfig",
    expected: "B",
    observed: g1CompileFailure ? "B" : "D",
    evidence:
      g1.status === 0 ? "build unexpectedly succeeded" : g1Diagnostics || `exit ${g1.status}`,
  });

  // ---- Arm G2: Angular-compiled graph, experimentalDecorators: false ----
  console.log("Arm G2 — Angular-compiled graph, experimentalDecorators: false…");
  const g2Env = { [PROBE_TSCONFIG_ENV]: STANDARD_DECORATORS_TSCONFIG };
  const g2Build = record(
    "G2 probe build (`experimentalDecorators: false`)",
    fixtureBuild("vite.probe.config.ts", g2Env),
  );

  let g2Prod: { status: number; ok: boolean; note: string } | undefined;

  if (g2Build.status === 0) {
    const tracedTslib = join(distDir, "analog", "server", "node_modules", "tslib");
    const tracedFiles = existsSync(tracedTslib)
      ? readdirSync(tracedTslib).sort().join(", ")
      : "none";
    const nodeEntryTraced = existsSync(join(tracedTslib, "modules", "index.js"));

    g2Prod = await withProductionServer("G2 production server", async (baseUrl, server) => {
      const page = await probePageObservation(baseUrl);
      const serverError = excerpt(server.output(), /ERR_MODULE_NOT_FOUND/, 1);

      return {
        ...page,
        note:
          `${page.note}; server log: ${serverError || "no module error"}; ` +
          `tslib files traced into dist/analog/server/node_modules: ${tracedFiles}`,
      };
    });

    check(
      "G2 failure cause: Node's `import`+`node` tslib entry is missing from the server output",
      !g2Prod.ok && !nodeEntryTraced && tracedFiles.includes("tslib.es6.mjs"),
      `traced: ${tracedFiles}`,
    );
  }

  arms.push({
    id: "G2-build",
    pipeline: "Angular-compiled graph (page → controller)",
    mode: "production build, `experimentalDecorators: false`",
    expected: "A",
    observed: g2Build.status === 0 ? "A" : "B",
    evidence: g2Build.status === 0 ? "build succeeded" : excerpt(g2Build.stderr, /error|Unable/i),
  });
  arms.push({
    id: "G2-prod",
    pipeline: "Angular-compiled graph (page → controller)",
    mode: "production server (SSR of the probe page)",
    expected: "C",
    observed: !g2Prod ? "B" : g2Prod.ok ? "A" : "C",
    evidence: g2Prod?.note ?? "no build to run",
  });

  const g2Dev = await withDevServer(
    "G2 dev server",
    { file: "vite.probe.config.ts", env: g2Env },
    (baseUrl) => probePageObservation(baseUrl),
  );

  arms.push({
    id: "G2-dev",
    pipeline: "Angular-compiled graph (page → controller)",
    mode: "dev server (SSR of the probe page)",
    expected: "A",
    observed: g2Dev.ok ? "A" : "C",
    evidence: g2Dev.note,
  });

  // ---- Baseline: stock configuration, production build ----
  console.log("Baseline — stock Analog production build…");
  rmSync(distDir, { recursive: true, force: true });

  const baselineBuild = record(
    "Baseline production build",
    run("pnpm", ["--filter", FIXTURE_PACKAGE, "run", "build"], { cwd: repoRoot }),
  );

  check(
    "Analog production build exits 0",
    baselineBuild.status === 0,
    `exit ${baselineBuild.status}`,
  );

  if (baselineBuild.status !== 0) {
    throw new Error(`Baseline build failed:\n${baselineBuild.stderr}\n${baselineBuild.stdout}`);
  }

  const artifacts = [
    { path: "dist/client/index.html", role: "Vite client build (browser bundle entry)" },
    { path: "dist/ssr/main.server.js", role: "Vite SSR build of the Angular app" },
    {
      path: "dist/analog/public/index.html",
      role: "Nitro public assets (client + prerendered pages)",
    },
    { path: "dist/analog/server/index.mjs", role: "Nitro production server entry" },
    { path: "dist/analog/server/chunks/routes/api/native.mjs", role: "Native Analog API route" },
    {
      path: "dist/analog/server/chunks/routes/api/strata-core.mjs",
      role: "Strata experiment route",
    },
    { path: "dist/analog/nitro.json", role: "Nitro build metadata" },
  ].map((artifact) => ({ ...artifact, exists: existsSync(join(fixtureDir, artifact.path)) }));

  check(
    "Client and server artifacts are generated",
    artifacts.every((artifact) => artifact.exists),
    artifacts
      .filter((artifact) => !artifact.exists)
      .map((artifact) => artifact.path)
      .join(", "),
  );

  const nitroMeta = readJson<{ preset: string; versions: { nitro: string } }>(
    join(distDir, "analog", "nitro.json"),
  );

  check(
    "Built server records the resolved Nitro version",
    nitroMeta.versions.nitro === nitropack.version,
    `nitro.json ${nitroMeta.versions.nitro}, resolved ${nitropack.version}`,
  );

  const strataCoreChunk = readFileSync(
    join(distDir, "analog", "server", "chunks", "routes", "api", "strata-core.mjs"),
    "utf8",
  );
  const nitroChunk = readFileSync(
    join(distDir, "analog", "server", "chunks", "nitro", "nitro.mjs"),
    "utf8",
  );
  const serverBundleH3 = {
    file: "dist/analog/server/chunks/nitro/nitro.mjs",
    createApp: /\bfunction createApp\(/.test(nitroChunk),
    createRouter: /\bfunction createRouter\(/.test(nitroChunk),
    h3Class: /\bclass H3\b/.test(nitroChunk),
  };

  check(
    "Nitro lowered the consumer's standard decorators (no raw decorator syntax left)",
    /__decorateElement/.test(strataCoreChunk) && !/^\s*@(Controller|Get)\(/m.test(strataCoreChunk),
    "dist/analog/server/chunks/routes/api/strata-core.mjs",
  );
  check(
    "The built server bundles H3 v1 (createApp/createRouter) and no H3 v2 `H3` class",
    serverBundleH3.createApp && serverBundleH3.createRouter && !serverBundleH3.h3Class,
    JSON.stringify(serverBundleH3),
  );

  // ---- Production server ----
  console.log("Baseline — production server…");
  const prod = await withProductionServer("Production server", observeRoutes);

  check(
    "Native Analog route works in production",
    prod.native.ok,
    `${prod.native.status} ${prod.native.body}`,
  );
  check(
    "getControllerDefinition() metadata is correct in production",
    prod.strataCore.ok,
    `${prod.strataCore.status} ${prod.strataCore.body}`,
  );

  // ---- Marker scan (before the dev server, which does not touch dist) ----
  const scanTargets = [
    { label: "server", directory: "dist/analog/server" },
    { label: "SSR bundle", directory: "dist/ssr" },
    { label: "client", directory: "dist/client" },
    { label: "public", directory: "dist/analog/public" },
  ];
  const markerScans: MarkerScan[] = scanTargets.map(({ label, directory }) => ({
    label,
    directory,
    serverMarker: findFilesContaining(join(fixtureDir, directory), SERVER_MARKER),
    clientControlMarker: findFilesContaining(join(fixtureDir, directory), CLIENT_MARKER),
    coreInternalSymbol: findFilesContaining(join(fixtureDir, directory), CORE_INTERNAL_SYMBOL),
  }));
  const scanOf = (label: string): MarkerScan => {
    const scan = markerScans.find((candidate) => candidate.label === label);

    if (!scan) throw new Error(`Missing scan ${label}`);

    return scan;
  };

  check(
    "Server-only marker is present in server output",
    scanOf("server").serverMarker.length > 0,
    "dist/analog/server",
  );
  for (const label of ["client", "public", "SSR bundle"]) {
    check(
      `Server-only marker is absent from ${label} output`,
      scanOf(label).serverMarker.length === 0,
      scanOf(label).serverMarker.join(", "),
    );
  }
  check(
    "Client control marker is found in client output (scanner sanity)",
    scanOf("client").clientControlMarker.length > 0 &&
      scanOf("public").clientControlMarker.length > 0,
    "dist/client and dist/analog/public",
  );
  check(
    "@strata/core internals are absent from client output",
    scanOf("client").coreInternalSymbol.length === 0 &&
      scanOf("public").coreInternalSymbol.length === 0,
    "dist/client and dist/analog/public",
  );

  // ---- Dev server ----
  console.log("Baseline — dev server…");
  const dev = await withDevServer("Dev server", {}, observeRoutes);

  check(
    "Native Analog route works in the dev server",
    dev.native.ok,
    `${dev.native.status} ${dev.native.body}`,
  );
  check(
    "getControllerDefinition() metadata is correct in the dev server",
    dev.strataCore.ok,
    `${dev.strataCore.status} ${dev.strataCore.body}`,
  );

  const nitroArm = (mode: string, ok: boolean, evidence: string): Arm => ({
    id: mode === "production server" ? "N-prod" : "N-dev",
    pipeline: "Nitro server route (`src/server/**`)",
    mode,
    expected: "A",
    observed: ok ? "A" : "C",
    evidence,
  });

  arms.unshift(
    nitroArm("dev server", dev.strataCore.ok, `${dev.strataCore.status} ${dev.strataCore.body}`),
    nitroArm(
      "production server",
      prod.strataCore.ok,
      `${prod.strataCore.status} ${prod.strataCore.body}`,
    ),
  );

  for (const arm of arms) {
    check(
      `Arm ${arm.id} matches its recorded classification`,
      arm.observed === arm.expected,
      `expected ${arm.expected}, observed ${arm.observed}`,
    );
  }

  // ---- H3 seam ----
  console.log("Classifying the H3 seam…");
  if (!prod.seam)
    throw new Error("The seam probe returned no snapshot from the production server.");

  const h3RequirementSource = "packages/h3/src/register-controllers.ts";
  const strataH3RequiresAppOn = /\bapp\.on\(/.test(
    readFileSync(join(repoRoot, h3RequirementSource), "utf8"),
  );
  const seamMatchesAcrossModes = JSON.stringify(dev.seam) === JSON.stringify(prod.seam);
  const seamOutcome: Outcome = prod.seam.h3App.hasOn && !prod.seam.h3App.hasStack ? "A" : "B";

  check(
    "The seam is observable through the public Nitro plugin API",
    prod.seam.nitroAppKeys.includes("h3App"),
    prod.seam.nitroAppKeys.join(", "),
  );
  check(
    "The seam has the same shape in dev and production",
    seamMatchesAcrossModes,
    "snapshot comparison",
  );
  check(
    "Recorded seam outcome is B (H3 v1 app, no `.on`; @strata/h3 needs `.on`)",
    seamOutcome === "B" && strataH3RequiresAppOn,
    `outcome ${seamOutcome}, strataH3RequiresAppOn ${strataH3RequiresAppOn}`,
  );

  const report: AnalogReport = {
    generatedAt,
    baselineCommit,
    node: process.version,
    pnpm: run("pnpm", ["--version"]).stdout.trim(),
    dependencies,
    lockfile,
    h3Resolutions,
    serverBundleH3,
    nitro: {
      version: nitroMeta.versions.nitro,
      preset: nitroMeta.preset,
      previewCommand: "node dist/analog/server/index.mjs",
    },
    commands,
    build: { status: baselineBuild.status, artifacts },
    arms,
    nativeRoute: [
      { mode: "production server", status: prod.native.status, body: prod.native.body },
      { mode: "dev server", status: dev.native.status, body: dev.native.body },
    ],
    strataCore: [
      { mode: "production server", status: prod.strataCore.status, body: prod.strataCore.body },
      { mode: "dev server", status: dev.strataCore.status, body: dev.strataCore.body },
    ],
    seam: {
      snapshot: prod.seam,
      h3RequirementSource,
      strataH3RequiresAppOn,
      outcome: seamOutcome,
      verdict:
        "Nitro exposes its H3 through a public plugin hook, but as an H3 v1 `App` (`use`/`stack`) and " +
        "v1 `Router`, not an H3 v2 `H3` instance. The current `@strata/h3` cannot mount directly.",
    },
    markerScans,
    checks,
    preWorkaroundFailure: PRE_WORKAROUND_FAILURE,
    upstreamMetadata: UPSTREAM_METADATA,
  };

  writeFileSync(reportPath, renderReport(report));
  run("pnpm", ["exec", "prettier", "--write", reportPath], { cwd: repoRoot });

  const failed = checks.filter((entry) => !entry.passed);

  console.log(`\nReport written to ${reportPath}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed.`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
