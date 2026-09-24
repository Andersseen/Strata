import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "../consumer/lib/exec.ts";
import type { CommandResult } from "../consumer/lib/exec.ts";

import {
  ANALOG_ADAPTER_SYMBOL,
  CLIENT_MARKER,
  CONTROLLER_MARKER,
  FACTORY_MARKER,
  ANGULAR_DI_MARKER,
  CORE_INTERNAL_SYMBOL,
  EXPECTED_GREETING_BODY,
  EXPECTED_HELLO_DEFINITION,
  EXPECTED_LIFECYCLE_BODY,
  EXPECTED_PROBE_DEFINITION,
  EXPECTED_USER_BODY,
  EXPECTED_USERS_BODY,
  FIXTURE_PACKAGE,
  H3_ADAPTER_SYMBOL,
  SERVER_MARKER,
} from "./lib/constants.ts";
import { fingerprintH3, lockfileVersions, requirePackage } from "./lib/graph.ts";
import type { ResolvedPackage } from "./lib/graph.ts";
import { findFreePort, httpGet, spawnManaged, waitForHttp } from "./lib/process.ts";
import type { ManagedProcess } from "./lib/process.ts";
import { renderReport } from "./lib/report.ts";
import type {
  AdapterReport,
  AnalogReport,
  Arm,
  Check,
  CommandSummary,
  DependencyRow,
  H3Resolution,
  MarkerScan,
  Outcome,
  RouteRow,
  SeamSnapshot,
} from "./lib/report.ts";
import { findFilesContaining, listFiles } from "./lib/scan.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "apps", "analog-fixture");
const analogDir = join(repoRoot, "packages", "analog");
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

function checkAngularDi(mode: string, observation: AngularDiObservation): void {
  for (const scenario of observation.scenarios) {
    check(
      `Angular DI experiment (${mode}): ${scenario.name}`,
      scenario.ok,
      `${scenario.responses.join(" | ")} delta ${scenario.delta}`,
    );
  }
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

interface JsonResponse<T> {
  status: number;
  contentType: string | null;
  body: string;
  json: T | null;
}

async function getJson<T>(url: string): Promise<JsonResponse<T>> {
  const result = await httpGet(url);
  const { status, contentType } = result;

  try {
    const json = JSON.parse(result.body) as T;

    // Dev servers pretty-print JSON; compact it so both modes compare and read alike.
    return { status, contentType, body: JSON.stringify(json), json };
  } catch {
    return { status, contentType, body: result.body, json: null };
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

interface Observed {
  status: number;
  contentType: string | null;
  body: string;
  ok: boolean;
}

interface RouteObservation {
  native: Observed;
  strataCore: Observed;
  /** `GET /api/strata/users`: registered only through `@strata/analog`. */
  users: Observed;
  /** `GET /api/strata/users/:id`: same controller, dynamic route. */
  user: Observed;
  /** Two sequential `GET /api/strata/lifecycle` requests: default per-request instances. */
  lifecycle: [Observed, Observed];
  /** Two sequential `GET /api/strata/greeting` requests: instances built by `controllerFactory`. */
  greeting: [Observed, Observed];
  /** SPEC-003 Angular DI scenarios under `/api/strata/angular-di`, with lifecycle counter deltas. */
  angularDi: AngularDiObservation;
  seam: SeamSnapshot | null;
}

interface AngularDiBody {
  met?: boolean | null;
  product?: { id?: string; name?: string };
  catalogInstance?: number;
  identity?: number;
  identityProductId?: string;
  auditSharesIdentity?: boolean;
  injectedRequestIsArgument?: boolean;
  injectInHandler?: string;
  injectAfterAwait?: string;
  destroyedBeforeResponse?: boolean;
}

interface AngularDiStats {
  injectorsCreated: number;
  injectorsDestroyed: number;
  injectorsAlive: number;
  maxInjectorsAlive: number;
  identitiesDestroyed: number;
  controllersReleased: number;
  catalogInstances: number;
}

interface AngularDiScenario {
  name: string;
  responses: string[];
  /** Lifecycle counters after the scenario, minus those before it. */
  delta: string;
  ok: boolean;
}

interface AngularDiObservation {
  scenarios: AngularDiScenario[];
}

/**
 * Stats that are levels rather than counters. `catalogInstances` is one: the
 * `providedIn: 'root'` service is created lazily by the first request of the
 * process and must stay at exactly one instance afterwards.
 */
const ANGULAR_DI_LEVELS = new Set(["injectorsAlive", "maxInjectorsAlive", "catalogInstances"]);

async function readAngularDiStats(baseUrl: string): Promise<AngularDiStats> {
  const stats = await getJson<AngularDiStats>(`${baseUrl}/api/strata-angular-di-stats`);

  if (!stats.json) throw new Error(`Unreadable Angular DI stats: ${stats.body}`);

  return stats.json;
}

/**
 * Runs one Angular DI scenario between two stats snapshots. Stats are read
 * once, with no retry, after every response has arrived: `onCleanup` runs
 * before Strata's route handler settles, so each request injector must already
 * be destroyed by then.
 */
async function angularDiScenario(
  baseUrl: string,
  name: string,
  send: () => Promise<JsonResponse<AngularDiBody>[]>,
  expect: (responses: JsonResponse<AngularDiBody>[], delta: AngularDiStats) => boolean,
): Promise<AngularDiScenario> {
  const before = await readAngularDiStats(baseUrl);
  const responses = await send();
  const after = await readAngularDiStats(baseUrl);
  const delta = Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      // Levels, not counters: keep them as observed.
      ANGULAR_DI_LEVELS.has(key) ? value : value - before[key as keyof AngularDiStats],
    ]),
  ) as unknown as AngularDiStats;

  return {
    name,
    responses: responses.map(describeAngularDiResponse),
    delta: JSON.stringify(delta),
    ok: expect(responses, delta),
  };
}

/**
 * A failed request is recorded by status and message only: the dev server's
 * error body carries a stack with absolute paths, which the committed report
 * must not contain.
 */
function describeAngularDiResponse(response: JsonResponse<AngularDiBody>): string {
  if (response.status < 400) return `${String(response.status)} ${response.body}`;

  const message = (response.json as { message?: unknown } | null)?.message;

  return `${String(response.status)} ${JSON.stringify({ message })}`;
}

/** Every request injector the scenario created was destroyed, with its request-scoped service and controller. */
const releasedAll = (delta: AngularDiStats, requests: number): boolean =>
  delta.injectorsCreated === requests &&
  delta.injectorsDestroyed === requests &&
  delta.identitiesDestroyed === requests &&
  delta.controllersReleased === requests &&
  delta.injectorsAlive === 0 &&
  delta.catalogInstances === 1;

async function observeAngularDi(baseUrl: string): Promise<AngularDiObservation> {
  const route = `${baseUrl}/api/strata/angular-di`;
  const meeting = randomUUID();

  // `met` says whether the fixture's rendezvous saw both requests suspended in
  // their handlers at once; everything else must hold either way.
  const answeredFor = (response: JsonResponse<AngularDiBody>, id: string, met: boolean): boolean =>
    response.status === 200 &&
    response.json?.met === met &&
    response.json.product?.id === id &&
    response.json.identityProductId === id &&
    response.json.auditSharesIdentity === true &&
    response.json.injectedRequestIsArgument === true &&
    response.json.injectInHandler === "NG0203" &&
    response.json.injectAfterAwait === "NG0203" &&
    response.json.destroyedBeforeResponse === false &&
    response.json.catalogInstance === 1;

  const overlap = await angularDiScenario(
    baseUrl,
    "two requests held at a rendezvous",
    () =>
      Promise.all([
        getJson<AngularDiBody>(`${route}/products/a?meet=${meeting}`),
        getJson<AngularDiBody>(`${route}/products/b?meet=${meeting}`),
      ]),
    ([a, b], delta) =>
      a !== undefined &&
      b !== undefined &&
      answeredFor(a, "a", true) &&
      answeredFor(b, "b", true) &&
      a.json?.identity !== b.json?.identity &&
      delta.maxInjectorsAlive >= 2 &&
      releasedAll(delta, 2),
  );
  // Negative control: a request alone at the rendezvous must not meet anyone. If
  // it did, the overlap scenario above would prove nothing about concurrency.
  const alone = await angularDiScenario(
    baseUrl,
    "one request alone at a rendezvous (control)",
    async () => [await getJson<AngularDiBody>(`${route}/products/solo?meet=${meeting}-solo`)],
    ([solo], delta) =>
      solo !== undefined && answeredFor(solo, "solo", false) && releasedAll(delta, 1),
  );
  // Production Nitro does not echo unhandled error messages, so a failure is
  // recognized by its status; the deltas show what was cleaned up.
  const failed = (response: JsonResponse<AngularDiBody> | undefined) => response?.status === 500;
  const thrown = await angularDiScenario(
    baseUrl,
    "handler throws synchronously",
    async () => [await getJson<AngularDiBody>(`${route}/fail/throw`)],
    ([response], delta) => failed(response) && releasedAll(delta, 1),
  );
  const rejected = await angularDiScenario(
    baseUrl,
    "async handler rejects after an await",
    async () => [await getJson<AngularDiBody>(`${route}/fail/reject`)],
    ([response], delta) => failed(response) && releasedAll(delta, 1),
  );

  return { scenarios: [overlap, alone, thrown, rejected] };
}

const isJson = (contentType: string | null): boolean =>
  contentType?.includes("application/json") ?? false;

async function observeRoutes(baseUrl: string): Promise<RouteObservation> {
  const native = await getJson<NativeBody>(`${baseUrl}/api/native`);
  const strata = await getJson<StrataCoreBody>(`${baseUrl}/api/strata-core`);
  const seam = await getJson<SeamBody>(`${baseUrl}/api/seam`);
  const users = await getJson<unknown>(`${baseUrl}/api/strata/users`);
  const user = await getJson<unknown>(`${baseUrl}/api/strata/users/42`);
  const expectBody = async (path: string, expected: unknown): Promise<Observed> => {
    const result = await getJson<unknown>(`${baseUrl}${path}`);

    return {
      status: result.status,
      contentType: result.contentType,
      body: result.body,
      ok:
        result.status === 200 &&
        isJson(result.contentType) &&
        result.body === JSON.stringify(expected),
    };
  };
  // Sequential on purpose: a shared controller instance would answer `calls: 2` the second time.
  const lifecycle: [Observed, Observed] = [
    await expectBody("/api/strata/lifecycle", EXPECTED_LIFECYCLE_BODY),
    await expectBody("/api/strata/lifecycle", EXPECTED_LIFECYCLE_BODY),
  ];
  const greeting: [Observed, Observed] = [
    await expectBody("/api/strata/greeting", EXPECTED_GREETING_BODY),
    await expectBody("/api/strata/greeting", EXPECTED_GREETING_BODY),
  ];

  const angularDi = await observeAngularDi(baseUrl);

  return {
    lifecycle,
    greeting,
    angularDi,
    native: {
      status: native.status,
      contentType: native.contentType,
      body: native.body,
      ok: native.status === 200 && native.json?.source === "analog",
    },
    users: {
      status: users.status,
      contentType: users.contentType,
      body: users.body,
      ok:
        users.status === 200 &&
        isJson(users.contentType) &&
        users.body === JSON.stringify(EXPECTED_USERS_BODY),
    },
    user: {
      status: user.status,
      contentType: user.contentType,
      body: user.body,
      ok:
        user.status === 200 &&
        isJson(user.contentType) &&
        user.body === JSON.stringify(EXPECTED_USER_BODY),
    },
    strataCore: {
      status: strata.status,
      contentType: strata.contentType,
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

/** Bare (non-relative) module specifiers imported by a JS or declaration file. */
function bareImports(source: string): string[] {
  const specifiers = new Set<string>();

  for (const match of source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = match[1];

    if (specifier && !specifier.startsWith(".")) specifiers.add(specifier);
  }

  return [...specifiers].sort();
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
}

/**
 * Type-checks the real `defineNitroPlugin` + `@strata/analog` call against
 * Nitro's own published types (the `nitropack` Analog resolves — the fixture
 * does not declare a second copy). `nitroApp.router` must be accepted as-is
 * and, as a negative control, the H3 v1 `nitroApp.h3App` must be rejected:
 * the `@ts-expect-error` makes the check fail if the parameter were `any`.
 *
 * The probe and its tsconfig are generated (the nitropack path is a
 * store-specific absolute path) and removed afterwards.
 */
function typecheckAgainstNitro(nitropackDir: string): CommandResult {
  const probeDir = join(fixtureDir, ".strata-typecheck");

  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(probeDir);

  try {
    writeFileSync(
      join(probeDir, "probe.ts"),
      [
        'import { registerControllers } from "@strata/analog";',
        'import { defineNitroPlugin } from "nitropack/runtime";',
        "",
        'import { UsersController } from "../src/server/strata/users.controller";',
        "",
        "// SPEC-003: the Angular DI plugin, with Angular's `@Injectable()` used as a",
        "// standard class decorator in the same Nitro server graph.",
        'export { default as angularDiPlugin } from "../src/server/plugins/strata-angular-di";',
        "",
        "export default defineNitroPlugin((nitroApp) => {",
        "  registerControllers(nitroApp.router, [UsersController]);",
        "  // @ts-expect-error the H3 v1 app is not the Nitro router seam",
        "  registerControllers(nitroApp.h3App, [UsersController]);",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(probeDir, "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: {
          noEmit: true,
          // The fixture's stock `experimentalDecorators: true` is the Angular
          // graph's problem (arm G1); Nitro server code uses standard decorators.
          experimentalDecorators: false,
          baseUrl: "..",
          rootDir: "..",
          paths: { "nitropack/runtime": [join(nitropackDir, "runtime.d.ts")] },
        },
        files: ["probe.ts"],
      }),
    );

    return record(
      "Type-check `@strata/analog` against Nitro's types",
      run("pnpm", ["exec", "tsc", "-p", ".strata-typecheck/tsconfig.json"], { cwd: fixtureDir }),
    );
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
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

  console.log("Preparing @strata/analog (the fixture consumes its built dist)…");
  const analogBuild = record(
    "Build @strata/analog",
    run("pnpm", ["--filter", "@strata/analog", "run", "build"], { cwd: repoRoot }),
  );

  if (analogBuild.status !== 0) {
    throw new Error(`@strata/analog failed to build:\n${analogBuild.stderr}`);
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

  // ---- @strata/analog: package boundary ---------------------------------
  console.log("Inspecting the @strata/analog package boundary…");
  const analogManifest = readJson<PackageManifest>(join(analogDir, "package.json"));
  const analogDist = join(analogDir, "dist");
  const analogArtifacts = [
    "packages/analog/dist/index.js",
    "packages/analog/dist/index.d.ts",
    "packages/analog/dist/register-controllers.d.ts",
  ].map((path) => ({ path, exists: existsSync(join(repoRoot, path)) }));
  const builtImports = listFiles(analogDist)
    .filter((file) => /\.(js|d\.ts)$/.test(file))
    .map((file) => ({
      file: `packages/analog/dist/${file}`,
      specifiers: bareImports(readFileSync(join(analogDist, file), "utf8")),
    }));
  const builtSpecifiers = [...new Set(builtImports.flatMap((row) => row.specifiers))].sort();
  const analogDependencyNames = Object.keys(analogManifest.dependencies ?? {});
  const analogEveryDependencyName = [
    ...analogDependencyNames,
    ...Object.keys(analogManifest.peerDependencies ?? {}),
    ...Object.keys(analogManifest.optionalDependencies ?? {}),
    ...Object.keys(analogManifest.devDependencies ?? {}),
  ];
  const publicEngines = ["core", "h3", "analog"].map((name) => ({
    name,
    node: readJson<PackageManifest>(join(repoRoot, "packages", name, "package.json")).engines?.node,
  }));

  check(
    "@strata/analog builds (JS + declarations)",
    analogBuild.status === 0 && analogArtifacts.every((artifact) => artifact.exists),
    analogArtifacts
      .filter((artifact) => !artifact.exists)
      .map((artifact) => artifact.path)
      .join(", "),
  );
  check(
    "@strata/analog depends only on @strata/core at runtime and declares no peers",
    analogDependencyNames.join() === "@strata/core" &&
      Object.keys(analogManifest.peerDependencies ?? {}).length === 0,
    JSON.stringify({
      dependencies: analogManifest.dependencies,
      peerDependencies: analogManifest.peerDependencies,
    }),
  );
  check(
    "@strata/analog does not depend on @strata/h3 (in any dependency field)",
    !analogEveryDependencyName.includes("@strata/h3"),
    analogEveryDependencyName.join(", "),
  );
  check(
    "The built @strata/analog (JS and .d.ts) imports only @strata/core — no h3, nitropack or Analog",
    builtSpecifiers.join() === "@strata/core",
    builtSpecifiers.join(", ") || "none",
  );
  check(
    "Public package engines are not raised to the fixture's Node floor",
    publicEngines.every((entry) => entry.node === ">=22"),
    publicEngines.map((entry) => `${entry.name}: ${entry.node}`).join(", "),
  );

  // ---- @strata/analog: consumer boundary --------------------------------
  const fixtureSourceFiles = listFiles(join(fixtureDir, "src")).filter((file) =>
    /\.(ts|tsx)$/.test(file),
  );
  const fixtureImports = [
    ...new Set(
      fixtureSourceFiles
        .flatMap((file) => bareImports(readFileSync(join(fixtureDir, "src", file), "utf8")))
        .filter((specifier) => specifier.includes("strata/analog")),
    ),
  ].sort();
  const fixtureConfigs = [
    "package.json",
    "vite.config.ts",
    "vite.probe.config.ts",
    ...readdirSync(fixtureDir).filter((file) => /^tsconfig.*\.json$/.test(file)),
  ];
  const sourceAliases = fixtureConfigs.filter((file) =>
    /packages\/analog/.test(readFileSync(join(fixtureDir, file), "utf8")),
  );
  const fixtureAnalog = requirePackage(fixtureDir, "@strata/analog");
  const pluginSource = readFileSync(
    join(fixtureDir, "src", "server", "plugins", "strata.ts"),
    "utf8",
  );
  const wrapperFiles = ["src/server/routes", "src/app"].flatMap((directory) =>
    ["UsersController", "users.controller"].flatMap((needle) =>
      findFilesContaining(join(fixtureDir, directory), needle).map(
        (file) => `${directory}/${file}`,
      ),
    ),
  );

  check(
    "The fixture imports only the public `@strata/analog` entry (no deep imports)",
    fixtureImports.join() === "@strata/analog",
    fixtureImports.join(", ") || "none",
  );
  check(
    "The fixture has no alias or path into packages/analog source",
    sourceAliases.length === 0 &&
      !findFilesContaining(join(fixtureDir, "src"), "packages/analog").length,
    sourceAliases.join(", "),
  );
  check(
    "The fixture resolves @strata/analog to the workspace package (via its package.json exports)",
    fixtureAnalog.dir === realpathSync(analogDir),
    `${fixtureAnalog.dir} vs ${realpathSync(analogDir)}`,
  );
  check(
    "The Strata route is registered by the Nitro plugin, not by a file-system route wrapper",
    /registerControllers\(\s*nitroApp\.router\b/.test(pluginSource) && wrapperFiles.length === 0,
    wrapperFiles.join(", ") || "plugin calls registerControllers(nitroApp.router, …)",
  );

  const typecheck = typecheckAgainstNitro(nitropack.dir);

  check(
    "Nitro's real `nitroApp.router` type is accepted by registerControllers as-is; `nitroApp.h3App` is rejected",
    typecheck.status === 0,
    `${typecheck.stdout}${typecheck.stderr}`.trim(),
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
  check(
    "GET /api/strata/users (registered by @strata/analog) returns 200 JSON in production",
    prod.users.ok,
    `${prod.users.status} ${prod.users.contentType} ${prod.users.body}`,
  );
  check(
    "GET /api/strata/users/:id (dynamic route) returns 200 JSON in production",
    prod.user.ok,
    `${prod.user.status} ${prod.user.contentType} ${prod.user.body}`,
  );
  check(
    "Two GET /api/strata/lifecycle requests each get a new controller ({ calls: 1 }) in production",
    prod.lifecycle.every((observed) => observed.ok),
    prod.lifecycle.map((observed) => `${observed.status} ${observed.body}`).join(" | "),
  );
  check(
    "GET /api/strata/greeting uses the custom controllerFactory per request in production",
    prod.greeting.every((observed) => observed.ok),
    prod.greeting.map((observed) => `${observed.status} ${observed.body}`).join(" | "),
  );
  // The experiment's request injectors must be released through `onCleanup` alone, not through
  // Nitro request/afterResponse/error hooks or a mutable slot on `event.context`.
  const angularDiSources = [
    "src/server/plugins/strata-angular-di.ts",
    "src/server/strata/angular-di/angular-controller-factory.ts",
    "src/server/strata/angular-di/angular-di.controller.ts",
    "src/server/strata/angular-di/providers.ts",
    "src/server/strata/angular-di/rendezvous.ts",
  ].map((path) => ({ path, source: readFileSync(join(fixtureDir, path), "utf8") }));
  // Controller-side code (not the Nitro plugin that wires it) must stay free of Nitro/H3 types.
  const controllerSideNitroTypes = angularDiSources.filter(
    ({ path, source }) =>
      path.startsWith("src/server/strata/") &&
      /from\s+["'](?:h3|nitropack(?:\/[^"']*)?)["']|\b(?:H3Event|NitroApp|EventHandlerRequest)\b/.test(
        source,
      ),
  );
  const nitroLifecycleGlue = angularDiSources.filter(({ source }) =>
    /hooks\.hook\(\s*["'](?:request|beforeResponse|afterResponse|error)["']|event\.context/.test(
      source,
    ),
  );

  check(
    "Angular DI experiment releases request injectors via onCleanup, with no Nitro request-lifecycle hooks",
    nitroLifecycleGlue.length === 0 &&
      angularDiSources.some(({ source }) => /\bonCleanup\(/.test(source)),
    nitroLifecycleGlue.map(({ path }) => path).join(", ") || "onCleanup() not found",
  );
  check(
    "Angular DI controller, services and factory import no Nitro/H3 module or event type",
    controllerSideNitroTypes.length === 0,
    controllerSideNitroTypes.map(({ path }) => path).join(", ") || "none",
  );
  checkAngularDi("production", prod.angularDi);

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
    controllerMarker: findFilesContaining(join(fixtureDir, directory), CONTROLLER_MARKER),
    factoryMarker: findFilesContaining(join(fixtureDir, directory), FACTORY_MARKER),
    angularDiMarker: findFilesContaining(join(fixtureDir, directory), ANGULAR_DI_MARKER),
    analogAdapterSymbol: findFilesContaining(join(fixtureDir, directory), ANALOG_ADAPTER_SYMBOL),
    h3AdapterSymbol: findFilesContaining(join(fixtureDir, directory), H3_ADAPTER_SYMBOL),
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
    "The @strata/analog-registered controllers' markers are present in server output",
    scanOf("server").controllerMarker.length > 0 &&
      scanOf("server").factoryMarker.length > 0 &&
      scanOf("server").angularDiMarker.length > 0,
    "dist/analog/server",
  );
  check(
    "@strata/analog is bundled into the server output",
    scanOf("server").analogAdapterSymbol.length > 0,
    "dist/analog/server",
  );
  for (const label of ["client", "public", "SSR bundle"]) {
    check(
      `The registered controllers' markers and @strata/analog are absent from ${label} output`,
      scanOf(label).controllerMarker.length === 0 &&
        scanOf(label).factoryMarker.length === 0 &&
        scanOf(label).angularDiMarker.length === 0 &&
        scanOf(label).analogAdapterSymbol.length === 0,
      [
        ...scanOf(label).controllerMarker,
        ...scanOf(label).factoryMarker,
        ...scanOf(label).angularDiMarker,
        ...scanOf(label).analogAdapterSymbol,
      ].join(", "),
    );
  }
  check(
    "No @strata/h3 code is in any output (the Analog adapter does not use it)",
    markerScans.every((scan) => scan.h3AdapterSymbol.length === 0),
    markerScans.flatMap((scan) => scan.h3AdapterSymbol).join(", "),
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
  check(
    "GET /api/strata/users (registered by @strata/analog) returns 200 JSON in the dev server",
    dev.users.ok,
    `${dev.users.status} ${dev.users.contentType} ${dev.users.body}`,
  );
  check(
    "GET /api/strata/users/:id (dynamic route) returns 200 JSON in the dev server",
    dev.user.ok,
    `${dev.user.status} ${dev.user.contentType} ${dev.user.body}`,
  );
  check(
    "Two GET /api/strata/lifecycle requests each get a new controller ({ calls: 1 }) in the dev server",
    dev.lifecycle.every((observed) => observed.ok),
    dev.lifecycle.map((observed) => `${observed.status} ${observed.body}`).join(" | "),
  );
  check(
    "GET /api/strata/greeting uses the custom controllerFactory per request in the dev server",
    dev.greeting.every((observed) => observed.ok),
    dev.greeting.map((observed) => `${observed.status} ${observed.body}`).join(" | "),
  );
  checkAngularDi("the dev server", dev.angularDi);

  const nitroArm = (mode: string, ok: boolean, evidence: string): Arm => ({
    id: mode === "production server" ? "N-prod" : "N-dev",
    pipeline: "Nitro server route (`src/server/**`)",
    mode,
    expected: "A",
    observed: ok ? "A" : "C",
    evidence,
  });
  const adapterArm = (mode: string, ok: boolean, evidence: string): Arm => ({
    id: mode === "production server" ? "S-prod" : "S-dev",
    pipeline: "Strata controller via `@strata/analog` (`nitroApp.router`)",
    mode,
    expected: "A",
    observed: ok ? "A" : "C",
    evidence,
  });

  arms.unshift(
    adapterArm("dev server", dev.users.ok, `${dev.users.status} ${dev.users.body}`),
    adapterArm("production server", prod.users.ok, `${prod.users.status} ${prod.users.body}`),

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

  const routeRow = (route: string, mode: string, observed: Observed): RouteRow => ({
    route,
    mode,
    status: observed.status,
    contentType: observed.contentType,
    body: observed.body,
  });
  const adapter: AdapterReport = {
    manifest: {
      dependencies: analogManifest.dependencies ?? {},
      peerDependencies: analogManifest.peerDependencies ?? {},
      devDependencies: analogManifest.devDependencies ?? {},
      engines: analogManifest.engines?.node ?? "unset",
    },
    builtImports,
    fixtureImports,
    build: { status: analogBuild.status, artifacts: analogArtifacts },
    routes: [
      routeRow("GET /api/strata/users", "production server", prod.users),
      routeRow("GET /api/strata/users", "dev server", dev.users),
      routeRow("GET /api/strata/users/42", "production server", prod.user),
      routeRow("GET /api/strata/users/42", "dev server", dev.user),
      ...(["production server", "dev server"] as const).flatMap((mode) => {
        const observed = mode === "production server" ? prod : dev;

        return [
          routeRow("GET /api/strata/lifecycle (1st)", mode, observed.lifecycle[0]),
          routeRow("GET /api/strata/lifecycle (2nd)", mode, observed.lifecycle[1]),
          routeRow("GET /api/strata/greeting (1st)", mode, observed.greeting[0]),
          routeRow("GET /api/strata/greeting (2nd)", mode, observed.greeting[1]),
        ];
      }),
    ],
    angularDi: [
      { mode: "production server", ...prod.angularDi },
      { mode: "dev server", ...dev.angularDi },
    ],
    typecheck: {
      command: portable(typecheck.command),
      status: typecheck.status,
      note:
        "A generated probe calls `registerControllers(nitroApp.router, …)` inside `defineNitroPlugin` " +
        "and type-checks it against the `nitropack` Analog resolves: the router is accepted without a " +
        "cast, and `nitroApp.h3App` (H3 v1 `App`) is rejected — a `@ts-expect-error` negative control " +
        "that fails if the parameter were loosely typed.",
    },
  };

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
    adapter,
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
