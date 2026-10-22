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
  expectHead,
  expectHeadMethodNotAllowed,
  expectJsonNotFound,
  expectMethodNotAllowed,
  expectNativeServed,
  expectNoCors,
  expectOptions,
  looksLikeHtml,
  rawRequest,
} from "../consumer/lib/http-routing.ts";
import type { Verdict } from "../consumer/lib/http-routing.ts";

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
  METHOD_REQUESTS,
  SERVER_MARKER,
} from "./lib/constants.ts";
import { fingerprintH3, lockfileVersions, requirePackage } from "./lib/graph.ts";
import type { ResolvedPackage } from "./lib/graph.ts";
import { findFreePort, httpGet, httpRequest, spawnManaged, waitForHttp } from "./lib/process.ts";
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

The \`alpha\` line is the only one whose declared runtime is H3 v2 (same major as \`@strata-sc/h3\`).
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
  /** `GET /api/strata/users`: registered only through `@strata-sc/analog`. */
  users: Observed;
  /** `GET /api/strata/users/:id`: same controller, dynamic route. */
  user: Observed;
  /** Two sequential `GET /api/strata/lifecycle` requests: default per-request instances. */
  lifecycle: [Observed, Observed];
  /** Two sequential `GET /api/strata/greeting` requests: instances built by `controllerFactory`. */
  greeting: [Observed, Observed];
  /** `METHOD_REQUESTS` against `/api/strata/methods`: one route per HTTP method. */
  methods: Array<{ label: string; observed: Observed }>;
  validation: Observed[];
  validationConcurrency: boolean;
  validationBodyPolicy: boolean;
  guardContract: boolean;
  inventoryContract: boolean;
  inventoryDetail: string;
  routingContract: boolean;
  routingDetail: string;
  guardDetail: string;
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
  principal?: string;
  configuration?: string;
  interceptorOrder?: string[];
}

interface AngularDiStats {
  injectorsCreated: number;
  injectorsDestroyed: number;
  injectorsAlive: number;
  maxInjectorsAlive: number;
  identitiesDestroyed: number;
  controllersReleased: number;
  catalogInstances: number;
  guardEntered: number;
  guardCleanups: number;
  interceptorEvents: number;
  interceptorCleanups: number;
  controllerConstructions: number;
  handlerCalls: number;
  cleanupOrderChecks: number;
  cleanupOrderFailures: number;
  interceptorLiveChecks: number;
  interceptorLiveFailures: number;
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

  const error = response.json as { message?: unknown; error?: unknown; source?: unknown } | null;
  const message = error?.message;

  return `${String(response.status)} ${JSON.stringify({ error: error?.error, source: error?.source, message })}`;
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

  const protectedRoute = `${route}/protected/products`;
  const requestProtected = async (
    path: string,
    token?: string,
    method = "GET",
    body?: unknown,
    contentType = "application/json",
  ): Promise<JsonResponse<AngularDiBody>> => {
    const response = await fetch(`${protectedRoute}/${path}`, {
      method,
      headers: {
        connection: "close",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": contentType }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: AngularDiBody | null = null;
    try {
      json = JSON.parse(text) as AngularDiBody;
    } catch {
      /* native or safe error response */
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: json === null ? text : JSON.stringify(json),
      json,
    };
  };
  const tokenFor = (principal: "alpha" | "beta") => `fixture-${principal}`;
  const composedOrder = [
    "timing:before",
    "outcome:before",
    "injector:created",
    "outcome:after",
    "timing:after",
  ];

  const composedSuccess = await angularDiScenario(
    baseUrl,
    "authorized DI routes compose verified principals, interceptors and Standard Schema",
    () =>
      Promise.all([
        requestProtected("101?tag=transformed", tokenFor("alpha")),
        requestProtected("102?tag=post", tokenFor("beta"), "POST", { count: "7" }),
      ]),
    ([get, post], delta) =>
      get?.status === 200 &&
      get.json?.principal === "alpha" &&
      get.json?.product?.id === "101" &&
      get.json?.tag === "TRANSFORMED" &&
      get.json?.auditSharesIdentity === true &&
      get.json?.injectedRequestIsArgument === true &&
      get.json?.destroyedBeforeResponse === false &&
      JSON.stringify(get.json?.interceptorOrder) === JSON.stringify(composedOrder) &&
      post?.status === 200 &&
      post.json?.principal === "beta" &&
      post.json?.count === 7 &&
      JSON.stringify(post.json?.interceptorOrder) === JSON.stringify(composedOrder) &&
      delta.injectorsCreated === 2 &&
      delta.injectorsDestroyed === 2 &&
      delta.guardEntered === 2 &&
      delta.guardCleanups === 2 &&
      delta.interceptorEvents === 4 &&
      delta.interceptorCleanups === 4 &&
      delta.controllerConstructions === 2 &&
      delta.handlerCalls === 2 &&
      delta.injectorsAlive === 0 &&
      delta.cleanupOrderFailures === 0 &&
      delta.cleanupOrderChecks === 2 &&
      delta.interceptorLiveChecks === 4 &&
      delta.interceptorLiveFailures === 0,
  );

  const denied = await angularDiScenario(
    baseUrl,
    "401 and 403 denials run guard cleanup before any interceptor or Angular construction",
    () =>
      Promise.all([
        requestProtected("alpha-product?tag=x"),
        requestProtected("alpha-product?tag=x", "invalid-canary"),
        requestProtected("alpha-product?tag=x", tokenFor("beta")),
        requestProtected("beta-product?tag=x", tokenFor("alpha")),
      ]),
    (responses, delta) =>
      responses.map((response) => response.status).join(",") === "401,401,403,403" &&
      responses.every(
        (response) =>
          !response.body.includes("alpha") &&
          !response.body.includes("beta") &&
          !response.body.includes("canary"),
      ) &&
      delta.injectorsCreated === 0 &&
      delta.controllerConstructions === 0 &&
      delta.handlerCalls === 0 &&
      delta.guardEntered === 4 &&
      delta.guardCleanups === 4 &&
      delta.interceptorEvents === 0 &&
      delta.interceptorCleanups === 0 &&
      delta.injectorsAlive === 0,
  );

  const validationFailure = await angularDiScenario(
    baseUrl,
    "invalid Standard Schema input is safe and destroys the authorized request injector",
    async () => [
      await requestProtected("not-a-number?tag=PRIVATE_SCHEMA_CANARY", tokenFor("alpha")),
    ],
    ([response], delta) =>
      response?.status === 400 &&
      response.body === '{"error":"invalid_request","source":"params"}' &&
      !response.body.includes("PRIVATE") &&
      delta.injectorsCreated === 1 &&
      delta.injectorsDestroyed === 1 &&
      delta.guardCleanups === 1 &&
      delta.interceptorCleanups === 2 &&
      delta.handlerCalls === 1 &&
      delta.injectorsAlive === 0,
  );

  const bodyFailures = await angularDiScenario(
    baseUrl,
    "malformed, unsupported and oversized JSON failures clean up request injectors",
    () =>
      Promise.all([
        requestProtected(
          "101?tag=x",
          tokenFor("alpha"),
          "POST",
          "{ PRIVATE_BODY_CANARY",
          "application/json",
        ),
        requestProtected("101?tag=x", tokenFor("alpha"), "POST", "{}", "text/plain"),
        requestProtected("101?tag=x", tokenFor("alpha"), "POST", {
          count: `1${"x".repeat(1024 * 1024)}`,
        }),
      ]),
    (responses, delta) =>
      responses.map((response) => response.status).join(",") === "400,415,413" &&
      responses.every(
        (response) =>
          !response.body.includes("PRIVATE") && response.body.includes('"source":"body"'),
      ) &&
      delta.injectorsCreated === 3 &&
      delta.injectorsDestroyed === 3 &&
      delta.injectorsAlive === 0 &&
      delta.guardCleanups === 3 &&
      delta.interceptorCleanups === 6,
  );

  const override = await angularDiScenario(
    baseUrl,
    "request provider override remains local to one child injector",
    () =>
      Promise.all([
        requestProtected("101?tag=x&override=only-this-request", tokenFor("alpha")),
        requestProtected("102?tag=x", tokenFor("beta")),
      ]),
    ([overridden, sibling], delta) =>
      overridden?.json?.configuration === "only-this-request" &&
      sibling?.json?.configuration === "application" &&
      overridden.json?.principal === "alpha" &&
      sibling.json?.principal === "beta" &&
      overridden.json?.identity !== sibling.json?.identity &&
      delta.catalogInstances === 1 &&
      delta.injectorsCreated === 2 &&
      delta.injectorsDestroyed === 2 &&
      delta.injectorsAlive === 0,
  );

  const factoryFailure = await angularDiScenario(
    baseUrl,
    "controller factory failure runs guard and interceptor cleanup without an injector",
    async () => [await requestProtected("101?tag=x&factoryFailure=true", tokenFor("alpha"))],
    ([response], delta) =>
      response?.status === 500 &&
      !response.body.includes("fixture-private") &&
      delta.injectorsCreated === 0 &&
      delta.injectorsDestroyed === 0 &&
      delta.guardCleanups === 1 &&
      delta.interceptorCleanups === 2 &&
      delta.controllerConstructions === 0 &&
      delta.handlerCalls === 0 &&
      delta.injectorsAlive === 0,
  );

  const providerFailure = await angularDiScenario(
    baseUrl,
    "provider factory failure destroys the created request injector",
    async () => [await requestProtected("101?tag=x&providerFailure=true", tokenFor("alpha"))],
    ([response], delta) =>
      response?.status === 500 &&
      !response.body.includes("fixture-private") &&
      delta.injectorsCreated === 1 &&
      delta.injectorsDestroyed === 1 &&
      delta.guardCleanups === 1 &&
      delta.interceptorCleanups === 2 &&
      delta.controllerConstructions === 0 &&
      delta.handlerCalls === 0 &&
      delta.injectorsAlive === 0,
  );

  const constructionFailure = await angularDiScenario(
    baseUrl,
    "controller constructor failure destroys its request injector",
    async () => [await requestProtected("101?tag=x&constructFailure=true", tokenFor("alpha"))],
    ([response], delta) =>
      response?.status === 500 &&
      !response.body.includes("fixture-private") &&
      delta.injectorsCreated === 1 &&
      delta.injectorsDestroyed === 1 &&
      delta.identitiesDestroyed === 1 &&
      delta.controllersReleased === 0 &&
      delta.guardCleanups === 1 &&
      delta.interceptorCleanups === 2 &&
      delta.controllerConstructions === 1 &&
      delta.handlerCalls === 0 &&
      delta.injectorsAlive === 0,
  );

  const downstreamFailures = await angularDiScenario(
    baseUrl,
    "handler, interceptor and multiple cleanup failures settle without leaking private errors",
    async () => {
      const responses: JsonResponse<AngularDiBody>[] = [];
      for (const path of [
        "101?tag=x&handlerFailure=sync",
        "101?tag=x&handlerFailure=async",
        "101?tag=x&interceptorFailure=after",
        "101?tag=x&handlerFailure=async&rethrowFailure=true",
        "101?tag=x&cleanupFailure=all",
      ]) {
        responses.push(await requestProtected(path, tokenFor("alpha")));
      }
      return responses;
    },
    (responses, delta) =>
      responses.every(
        (response) => response.status === 500 && !response.body.includes("fixture-private"),
      ) &&
      delta.injectorsCreated === 5 &&
      delta.injectorsDestroyed === 5 &&
      delta.injectorsAlive === 0 &&
      delta.guardCleanups === 5 &&
      delta.interceptorCleanups === 10 &&
      delta.handlerCalls === 5,
  );

  const interceptorFailure = await angularDiScenario(
    baseUrl,
    "interceptor failure before next cleans up without constructing a controller",
    async () => [await requestProtected("101?tag=x&interceptorFailure=before", tokenFor("alpha"))],
    ([response], delta) =>
      response?.status === 500 &&
      !response.body.includes("fixture-private") &&
      delta.injectorsCreated === 0 &&
      delta.injectorsDestroyed === 0 &&
      delta.guardCleanups === 1 &&
      delta.interceptorEvents === 2 &&
      delta.interceptorCleanups === 2 &&
      delta.controllerConstructions === 0 &&
      delta.handlerCalls === 0 &&
      delta.injectorsAlive === 0,
  );

  const nativeResponse = await angularDiScenario(
    baseUrl,
    "native Web Response is preserved through interceptors",
    async () => [await requestProtected("101?tag=x&nativeResponse=true", tokenFor("alpha"))],
    ([response], delta) =>
      response?.status === 200 &&
      response.body === "native-response-preserved" &&
      response.contentType?.includes("text/plain") === true &&
      delta.injectorsCreated === 1 &&
      delta.injectorsDestroyed === 1 &&
      delta.injectorsAlive === 0,
  );

  const matrix = await angularDiScenario(
    baseUrl,
    "24 mixed requests in three overlapping eight-request batches isolate state",
    async () => {
      const meeting = randomUUID();
      const requests = Array.from({ length: 24 }, (_, index) => () => {
        if (index < 8) {
          const principal = index % 2 === 0 ? "alpha" : "beta";
          return requestProtected(
            `${101 + index}?tag=m${index}&meet=${meeting}`,
            tokenFor(principal),
          );
        }
        if (index < 12) {
          return index % 2 === 0
            ? requestProtected("alpha-product?tag=x")
            : requestProtected("alpha-product?tag=x", "invalid-canary");
        }
        if (index < 16) return requestProtected("not-a-number?tag=x", tokenFor("alpha"));
        if (index < 20) {
          const principal = index % 2 === 0 ? "alpha" : "beta";
          return requestProtected(`${101 + index}?tag=x&handlerFailure=async`, tokenFor(principal));
        }
        const principal = index % 2 === 0 ? "alpha" : "beta";
        return requestProtected(
          `${101 + index}?tag=x&interceptorFailure=after`,
          tokenFor(principal),
        );
      });
      const firstBatch = await Promise.all(requests.slice(0, 8).map((send) => send()));
      const secondBatch = await Promise.all(requests.slice(8, 16).map((send) => send()));
      const thirdBatch = await Promise.all(requests.slice(16, 24).map((send) => send()));
      return [...firstBatch, ...secondBatch, ...thirdBatch];
    },
    (responses, delta) => {
      const rendezvousResponses = responses.slice(0, 8);
      const identities = rendezvousResponses.map((response) => response.json?.identity);
      const isolatedResponses = responses.every((response, index) =>
        index < 8
          ? response.status === 200 &&
            response.json?.met === true &&
            response.json?.identityProductId === String(101 + index)
          : index < 12
            ? response.status === 401
            : index < 16
              ? response.status === 400 &&
                response.body === '{"error":"invalid_request","source":"params"}'
              : response.status === 500 && !response.body.includes("fixture-private"),
      );
      return (
        isolatedResponses &&
        new Set(identities).size === 8 &&
        delta.injectorsCreated === 20 &&
        delta.injectorsDestroyed === 20 &&
        delta.injectorsAlive === 0 &&
        delta.maxInjectorsAlive >= 8 &&
        delta.catalogInstances === 1 &&
        delta.guardCleanups === 24 &&
        delta.interceptorCleanups === 40 &&
        delta.handlerCalls === 20 &&
        delta.cleanupOrderFailures === 0 &&
        delta.cleanupOrderChecks === 20 &&
        delta.interceptorLiveChecks >= 40 &&
        delta.interceptorLiveFailures === 0 &&
        !responses.some((response) => response.body.includes("PRIVATE"))
      );
    },
  );

  return {
    scenarios: [
      overlap,
      alone,
      thrown,
      rejected,
      composedSuccess,
      denied,
      validationFailure,
      bodyFailures,
      override,
      factoryFailure,
      providerFailure,
      constructionFailure,
      downstreamFailures,
      interceptorFailure,
      nativeResponse,
      matrix,
    ],
  };
}

const isJson = (contentType: string | null): boolean =>
  contentType?.includes("application/json") ?? false;

async function observeRoutes(baseUrl: string, devServer = false): Promise<RouteObservation> {
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

  const methods = [];

  for (const { method, path, json, expected } of METHOD_REQUESTS) {
    const result = await httpRequest(`${baseUrl}${path}`, { method, json });
    let body = result.body;

    try {
      body = JSON.stringify(JSON.parse(result.body));
    } catch {
      // Not JSON: keep the raw body for the report.
    }

    methods.push({
      label: `${method} ${path}${json === undefined ? "" : ` ${JSON.stringify(json)}`}`,
      observed: {
        status: result.status,
        contentType: result.contentType,
        body,
        ok:
          result.status === 200 && isJson(result.contentType) && body === JSON.stringify(expected),
      },
    });
  }

  const angularDi = await observeAngularDi(baseUrl);
  const validatedParams = await getJson<unknown>(`${baseUrl}/api/strata/validated/42?tag=a&tag=b`);
  const validatedBodyResult = await httpRequest(`${baseUrl}/api/strata/validated`, {
    method: "POST",
    json: { count: "7" },
  });
  let validatedBodyText = validatedBodyResult.body;
  try {
    validatedBodyText = JSON.stringify(JSON.parse(validatedBodyText));
  } catch {
    /* retain raw body */
  }
  const validatedBody = { ...validatedBodyResult, body: validatedBodyText };
  const invalidParams = await getJson<unknown>(`${baseUrl}/api/strata/validated/nope?tag=x`);
  const validated = [validatedParams, validatedBody, invalidParams].map((result, index) => {
    const expected = [
      '{"params":{"id":42},"query":{"tag":["a","b"]}}',
      '{"count":7}',
      '{"error":"invalid_request","source":"params"}',
    ][index];
    return {
      status: result.status,
      contentType: result.contentType,
      body: result.body,
      ok:
        result.status === (index === 2 ? 400 : 200) &&
        isJson(result.contentType) &&
        result.body === expected,
    };
  });
  const validationConcurrency = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const valid = index % 2 === 0;
      const id = valid ? String(index + 1) : "invalid";
      const requestId = `validation-${index}`;
      const privateValue = `PRIVATE_VALIDATION_CANARY_${index}`;
      const response = await fetch(`${baseUrl}/api/strata/validated/${id}?tag=${requestId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-correlation-id": requestId },
        body: JSON.stringify({ count: String(index), requestId, privateValue }),
      });
      const body = await response.text();
      if (!valid) {
        return (
          response.status === 400 &&
          response.headers.get("cache-control") === "no-store" &&
          response.headers.get("content-type")?.includes("application/json") === true &&
          body === '{"error":"invalid_request","source":"params"}' &&
          !body.includes(privateValue)
        );
      }
      try {
        return (
          response.status === 200 &&
          JSON.stringify(JSON.parse(body)) ===
            JSON.stringify({ id: index + 1, tag: requestId, count: index, requestId })
        );
      } catch {
        return false;
      }
    }),
  ).then((results) => results.every(Boolean));
  const jsonBodyCases = await Promise.all([
    fetch(`${baseUrl}/api/strata/validated`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "{ malformed PRIVATE_BODY_CANARY",
    }),
    fetch(`${baseUrl}/api/strata/validated`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    fetch(`${baseUrl}/api/strata/validated`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: `1${"x".repeat(1024 * 1024)}` }),
    }),
  ]);
  const jsonBodyExpected = [
    '{"error":"invalid_request","source":"body"}',
    '{"error":"unsupported_media_type","source":"body"}',
    '{"error":"payload_too_large","source":"body"}',
  ];
  const validationBodyPolicy = await Promise.all(
    jsonBodyCases.map(async (response, index) => {
      const body = await response.text();
      return (
        response.status === [400, 415, 413][index] &&
        response.headers.get("content-type")?.includes("application/json") === true &&
        response.headers.get("cache-control") === "no-store" &&
        body === jsonBodyExpected[index] &&
        !body.includes("PRIVATE_BODY_CANARY")
      );
    }),
  ).then((results) => results.every(Boolean));
  const guardResults = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const kind = index % 6;
      const method = kind === 0 || kind === 1 ? "POST" : kind === 5 ? "GET" : "DELETE";
      const id = kind === 2 ? "ada-product" : "grace-product";
      const path = method === "POST" ? "/api/protected-products" : `/api/protected-products/${id}`;
      const authorization =
        kind === 1
          ? "Bearer invalid-canary"
          : kind === 2 || kind === 3
            ? "Bearer fixture-token-ada"
            : kind === 4
              ? "Bearer fixture-token-grace"
              : undefined;
      const headers = new Headers();
      if (authorization) headers.set("authorization", authorization);
      const response = await fetch(`${baseUrl}${path}`, { method, headers });
      const text = await response.text();
      const status = kind === 0 || kind === 1 ? 401 : kind === 3 ? 403 : 200;
      const ok =
        response.status === status &&
        (status === 200 ||
          (response.headers.get("cache-control") === "no-store" &&
            response.headers.get("content-type") === "application/json; charset=utf-8" &&
            text === JSON.stringify({ error: status === 401 ? "unauthorized" : "forbidden" }) &&
            !text.includes("fixture-token") &&
            !text.includes("canary")));
      return {
        ok,
        observed: `${method} ${path}: ${response.status} ${response.headers.get("content-type")} ${text}`,
      };
    }),
  );
  const guardContract = guardResults.every(({ ok }) => ok);

  const inventory = await observeInventory(baseUrl);
  const routing = await observeHttpRouting(baseUrl, devServer);

  return {
    lifecycle,
    methods,
    validation: validated,
    validationConcurrency,
    validationBodyPolicy,
    guardContract,
    inventoryContract: inventory.ok,
    inventoryDetail: inventory.detail,
    routingContract: routing.ok,
    routingDetail: routing.detail,
    guardDetail: guardResults
      .filter(({ ok }) => !ok)
      .map(({ observed }) => observed)
      .join(" | "),
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

/**
 * The HTTP routing and API boundary contract on the real server (Analog dev
 * server or Nitro production build): an owned `/api` namespace answers JSON 404
 * and 405 + Allow, HEAD and OPTIONS follow the documented policy, native routes
 * are never shadowed, and pages stay HTML (docs/research/analog-http-routing-v06.md).
 */
async function observeHttpRouting(
  baseUrl: string,
  devServer: boolean,
): Promise<{ ok: boolean; detail: string }> {
  const send = (method: string, path: string, headers: Record<string, string> = {}) =>
    rawRequest(baseUrl, method, path, headers);
  const auth = { authorization: "Bearer fixture-token-ada" };
  const products = "/api/products/ada-product";
  const allow = "GET, HEAD, PATCH, DELETE, OPTIONS";
  const failures: string[] = [];
  const expect = (name: string, verdict: Verdict): void => {
    if (verdict !== undefined) failures.push(`${name}: ${verdict}`);
  };

  const found = await send("GET", products, auth);
  expect(
    "GET existing product",
    found.status === 200 && found.body.includes('"sku":"ADA-1"')
      ? undefined
      : `${found.status} ${found.body}`,
  );

  const invalidId = await send("GET", "/api/products/not-a-route", auth);
  expect(
    "GET /api/products/not-a-route reaches its handler (application 404, not a boundary answer)",
    invalidId.status === 404 &&
      invalidId.body === '{"error":"not_found"}' &&
      invalidId.headers.get("allow") === null
      ? undefined
      : `${invalidId.status} ${invalidId.body}`,
  );

  expect("GET /api/nonexistent", expectJsonNotFound(await send("GET", "/api/nonexistent")));
  expect(
    "GET unknown sub-route with a secret query",
    expectJsonNotFound(await send("GET", `${products}/unknown?token=PRIVATE_ROUTING_CANARY`)),
  );

  for (const method of ["TRACE", "PUT", "PROPFIND"]) {
    expect(`${method} ${products}`, expectMethodNotAllowed(await send(method, products), allow));
  }
  expect(
    "DELETE /api/products → 405 Allow: POST, OPTIONS",
    expectMethodNotAllowed(await send("DELETE", "/api/products"), "POST, OPTIONS"),
  );
  expect(
    "DELETE /api/products/ada-product/x is a 404, not a 405",
    expectJsonNotFound(await send("DELETE", `${products}/x`)),
  );

  const head = await send("HEAD", products, auth);
  expect("HEAD with credentials", expectHead(head, "application/json"));
  const headDenied = await send("HEAD", products);
  expect(
    "HEAD without credentials keeps the GET guard (401, no body)",
    headDenied.status === 401 && headDenied.body === ""
      ? undefined
      : `${headDenied.status} ${headDenied.body.length}`,
  );
  expect(
    "HEAD on a POST-only collection",
    expectHeadMethodNotAllowed(await send("HEAD", "/api/products"), "POST, OPTIONS"),
  );

  const preflightHeaders = {
    origin: "https://evil.example",
    "access-control-request-method": "DELETE",
  };

  if (devServer) {
    // `vite dev` runs its own CORS middleware ahead of Nitro and answers every OPTIONS
    // request itself, so the boundary never sees one. That is existing native middleware
    // ownership: Strata must leave the answer exactly as Vite wrote it.
    for (const headers of [{}, preflightHeaders]) {
      const viteOptions = await send("OPTIONS", products, headers);

      expect(
        "OPTIONS is answered by the dev server's own CORS middleware, untouched by Strata",
        viteOptions.status === 204 &&
          viteOptions.headers.has("access-control-allow-methods") &&
          !viteOptions.headers.has("allow")
          ? undefined
          : `${viteOptions.status} ${[...viteOptions.headers.keys()].join(",")}`,
      );
    }
  } else {
    expect("OPTIONS", expectOptions(await send("OPTIONS", products), allow));
    const preflight = await send("OPTIONS", products, preflightHeaders);
    expect(
      "OPTIONS preflight is not answered and carries no CORS header",
      expectMethodNotAllowed(preflight, "GET, HEAD, PATCH, DELETE") ?? expectNoCors(preflight),
    );
  }

  expect(
    "native GET /api/health is not shadowed",
    expectNativeServed(await send("GET", "/api/health"), { status: "ok", source: "nitro" }),
  );
  expect(
    "native all-method /api/native is not shadowed",
    expectNativeServed(await send("POST", "/api/native"), { source: "analog" }),
  );
  expect(
    "POST /api/health (declared native GET) → 405",
    expectMethodNotAllowed(await send("POST", "/api/health"), "GET, OPTIONS"),
  );

  const unauthorizedDelete = await send("DELETE", products);
  expect(
    "a matched route keeps its guard (DELETE without credentials → 401)",
    unauthorizedDelete.status === 401 ? undefined : String(unauthorizedDelete.status),
  );
  const unauthorizedPut = await send("PUT", products);
  expect(
    "an unsupported method is a 405 with no guard applied",
    expectMethodNotAllowed(unauthorizedPut, allow),
  );

  const page = await send("GET", "/");
  expect(
    "the Analog page stays HTML",
    page.status === 200 && looksLikeHtml(page)
      ? undefined
      : `${page.status} ${page.headers.get("content-type")}`,
  );

  // Twenty-four overlapping requests released together by one gate.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plan: {
    name: string;
    run: () => ReturnType<typeof send>;
    verdict: (reply: Awaited<ReturnType<typeof send>>) => Verdict;
  }[] = [];
  for (let index = 0; index < 4; index += 1) {
    plan.push(
      {
        name: "found",
        run: () => send("GET", products, auth),
        verdict: (r) => (r.status === 200 ? undefined : String(r.status)),
      },
      {
        name: "unknown",
        run: () => send("GET", `/api/unknown-${index}`),
        verdict: expectJsonNotFound,
      },
      {
        name: "405",
        run: () => send("PUT", products),
        verdict: (r) => expectMethodNotAllowed(r, allow),
      },
      {
        name: "native",
        run: () => send("GET", "/api/health"),
        verdict: (r) => expectNativeServed(r, { status: "ok", source: "nitro" }),
      },
      {
        name: "401",
        run: () => send("DELETE", products),
        verdict: (r) => (r.status === 401 ? undefined : String(r.status)),
      },
      {
        name: "head",
        run: () => send("HEAD", products, auth),
        verdict: (r) => expectHead(r, "application/json"),
      },
    );
  }
  for (let index = 0; index < (devServer ? 0 : 4); index += 1) {
    plan.push({
      name: "options",
      run: () => send("OPTIONS", products),
      verdict: (r) => expectOptions(r, allow),
    });
  }
  const pending = plan.map((entry) => gate.then(entry.run));
  release();
  (await Promise.all(pending)).forEach((reply, index) => {
    const entry = plan[index];
    const verdict = entry?.verdict(reply);
    if (verdict !== undefined) failures.push(`overlap ${entry?.name}: ${verdict}`);
  });
  if (plan.length < 24) failures.push(`only ${plan.length} overlapping requests`);

  return { ok: failures.length === 0, detail: failures.slice(0, 4).join(" | ") };
}

async function observeInventory(baseUrl: string): Promise<{ ok: boolean; detail: string }> {
  const base = `${baseUrl}/api/products`;
  const auth = { authorization: "Bearer fixture-token-ada" };
  const existing = await fetch(`${base}/ada-product`, { headers: auth });
  const existingBody = await existing.text();
  const missing = await fetch(`${base}/missing-product`, { method: "DELETE", headers: auth });
  const missingBody = await missing.text();
  const unauthenticated = await fetch(`${base}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "V05-UNAUTH", name: "Unauthorized" }),
  });
  const forbidden = await fetch(`${base}/grace-product`, { method: "DELETE", headers: auth });
  const invalid = await fetch(`${base}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: "{ malformed PRIVATE_INVENTORY_CANARY",
  });
  const duplicate = await fetch(`${base}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sku: "ADA-1", name: "Duplicate" }),
  });
  const duplicateBody = await duplicate.text();
  const created = await fetch(`${base}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ sku: "V05-PRODUCT", name: "Release sample" }),
  });
  const createdBody = await created.text();
  const updated = await fetch(`${base}/fixture-v05-product`, {
    method: "PATCH",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ status: "active", name: "Release sample updated" }),
  });
  const invalidState = await fetch(`${base}/fixture-v05-product`, {
    method: "PATCH",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ status: "archived" }),
  });
  const deleted = await fetch(`${base}/fixture-v05-product`, {
    method: "DELETE",
    headers: auth,
  });
  const checks = [
    existing.status === 200 && existingBody.includes('"sku":"ADA-1"'),
    missing.status === 404 &&
      missingBody === '{"error":"not_found"}' &&
      missing.headers.get("cache-control") === "no-store",
    unauthenticated.status === 401,
    forbidden.status === 403,
    invalid.status === 400 &&
      (await invalid.text()) === '{"error":"invalid_request","source":"body"}',
    duplicate.status === 409 &&
      duplicateBody === '{"error":"conflict"}' &&
      duplicate.headers.get("cache-control") === "no-store",
    created.status === 201 &&
      created.headers.get("x-fixture-contract") === "inventory" &&
      createdBody ===
        '{"id":"fixture-v05-product","sku":"V05-PRODUCT","name":"Release sample","status":"active"}',
    updated.status === 200 &&
      (await updated.text()) ===
        '{"id":"fixture-v05-product","sku":"V05-PRODUCT","name":"Release sample updated","status":"active"}',
    invalidState.status === 422 &&
      (await invalidState.text()) === '{"error":"invalid_product_state"}',
    deleted.status === 204 &&
      (await deleted.text()) === "" &&
      deleted.headers.get("content-type") === null,
  ];
  return {
    ok: checks.every(Boolean),
    detail: checks
      .map((check, index) => (check ? "" : `check ${index + 1} failed`))
      .filter(Boolean)
      .join(", "),
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
 * Type-checks the real `defineNitroPlugin` + `@strata-sc/analog` call against
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
        'import { registerControllers } from "@strata-sc/analog";',
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
      "Type-check `@strata-sc/analog` against Nitro's types",
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

  console.log("Preparing @strata-sc/core (the fixture consumes its built dist)…");
  const coreBuild = record(
    "Build @strata-sc/core",
    run("pnpm", ["--filter", "@strata-sc/core", "run", "build"], { cwd: repoRoot }),
  );

  if (coreBuild.status !== 0) {
    throw new Error(`@strata-sc/core failed to build:\n${coreBuild.stderr}`);
  }

  console.log("Preparing @strata-sc/analog (the fixture consumes its built dist)…");
  const analogBuild = record(
    "Build @strata-sc/analog",
    run("pnpm", ["--filter", "@strata-sc/analog", "run", "build"], { cwd: repoRoot }),
  );

  if (analogBuild.status !== 0) {
    throw new Error(`@strata-sc/analog failed to build:\n${analogBuild.stderr}`);
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
    requirePackage(fixtureDir, "@strata-sc/core"),
    declared["@strata-sc/core"] ?? "(transitive)",
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
  addDependency(strataH3, strataH3Manifest.dependencies["h3"] ?? "?", "H3 used by @strata-sc/h3");

  const h3Resolutions: H3Resolution[] = [];

  for (const [consumer, dir] of [
    ["`nitropack`", nitropack.dir],
    ["`@analogjs/vite-plugin-nitro`", vitePluginNitro.dir],
    ["`@strata-sc/h3`", strataH3Dir],
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
    "Analog/Nitro run H3 v1 and @strata-sc/h3 runs H3 v2",
    nitroH3.version.startsWith("1.") && strataH3.version.startsWith("2."),
    `nitropack → ${nitroH3.version}, @strata-sc/h3 → ${strataH3.version}`,
  );
  check(
    "No Nitro 3 (`nitro` package) in the workspace graph",
    !lockfile.some((row) => row.name === "nitro" && row.versions.length > 0),
    "lockfile scan",
  );

  // ---- @strata-sc/analog: package boundary ---------------------------------
  console.log("Inspecting the @strata-sc/analog package boundary…");
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
    "@strata-sc/analog builds (JS + declarations)",
    analogBuild.status === 0 && analogArtifacts.every((artifact) => artifact.exists),
    analogArtifacts
      .filter((artifact) => !artifact.exists)
      .map((artifact) => artifact.path)
      .join(", "),
  );
  check(
    "@strata-sc/analog declares only @strata-sc/core and Standard Schema, with no peers",
    analogDependencyNames.join() === "@standard-schema/spec,@strata-sc/core" &&
      Object.keys(analogManifest.peerDependencies ?? {}).length === 0,
    JSON.stringify({
      dependencies: analogManifest.dependencies,
      peerDependencies: analogManifest.peerDependencies,
    }),
  );
  check(
    "@strata-sc/analog does not depend on @strata-sc/h3 (in any dependency field)",
    !analogEveryDependencyName.includes("@strata-sc/h3"),
    analogEveryDependencyName.join(", "),
  );
  check(
    "The built @strata-sc/analog imports only core and Standard Schema — no h3, nitropack or Analog",
    builtSpecifiers.join() === "@standard-schema/spec,@strata-sc/core",
    builtSpecifiers.join(", ") || "none",
  );
  check(
    "Public package engines are not raised to the fixture's Node floor",
    publicEngines.every((entry) => entry.node === ">=22"),
    publicEngines.map((entry) => `${entry.name}: ${entry.node}`).join(", "),
  );

  // ---- @strata-sc/analog: consumer boundary --------------------------------
  const fixtureSourceFiles = listFiles(join(fixtureDir, "src")).filter((file) =>
    /\.(ts|tsx)$/.test(file),
  );
  const fixtureImports = [
    ...new Set(
      fixtureSourceFiles
        .flatMap((file) => bareImports(readFileSync(join(fixtureDir, "src", file), "utf8")))
        .filter((specifier) => specifier.includes("@strata-sc/analog")),
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
  const fixtureAnalog = requirePackage(fixtureDir, "@strata-sc/analog");
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
    "The fixture imports only the public `@strata-sc/analog` entry (no deep imports)",
    fixtureImports.join() === "@strata-sc/analog",
    fixtureImports.join(", ") || "none",
  );
  check(
    "The fixture has no alias or path into packages/analog source",
    sourceAliases.length === 0 &&
      !findFilesContaining(join(fixtureDir, "src"), "packages/analog").length,
    sourceAliases.join(", "),
  );
  check(
    "The fixture resolves @strata-sc/analog to the workspace package (via its package.json exports)",
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
  const prod = await withProductionServer("Production server", (baseUrl) => observeRoutes(baseUrl));

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
    "GET /api/strata/users (registered by @strata-sc/analog) returns 200 JSON in production",
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
  for (const { label, observed } of prod.methods) {
    check(
      `${label} reaches its own Strata handler with the right method/params/body in production`,
      observed.ok,
      `${observed.status} ${observed.contentType} ${observed.body}`,
    );
  }
  for (const [index, observed] of prod.validation.entries()) {
    check(
      `Standard Schema validation case ${index + 1} works in production`,
      observed.ok,
      `${observed.status} ${observed.contentType} ${observed.body}`,
    );
  }
  check(
    "24 overlapping mixed valid and invalid validation requests remain isolated in production",
    prod.validationConcurrency,
    "per-request params, query, transformed body, safe error and private canary checks",
  );
  check(
    "JSON body failures return real 400/413/415 no-store responses in production",
    prod.validationBodyPolicy,
    "malformed JSON, text/plain and >1 MiB JSON",
  );
  check(
    "24 overlapping synthetic guard requests preserve public, 401, 403 and owner access in production",
    prod.guardContract,
    prod.guardDetail || "opaque fixture tokens and denial non-disclosure",
  );
  check(
    "Inventory HTTP contract and protected mutation behavior work in production",
    prod.inventoryContract,
    prod.inventoryDetail || "safe errors, validated bodies, 201, patch and bodyless 204",
  );
  check(
    "HTTP routing and API boundary contract (JSON 404, 405 + Allow, HEAD, OPTIONS, native routes, 24 overlapping requests) works in production",
    prod.routingContract,
    prod.routingDetail || "owned /api namespace, native routes not shadowed, pages stay HTML",
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
    "The @strata-sc/analog-registered controllers' markers are present in server output",
    scanOf("server").controllerMarker.length > 0 &&
      scanOf("server").factoryMarker.length > 0 &&
      scanOf("server").angularDiMarker.length > 0,
    "dist/analog/server",
  );
  check(
    "@strata-sc/analog is bundled into the server output",
    scanOf("server").analogAdapterSymbol.length > 0,
    "dist/analog/server",
  );
  for (const label of ["client", "public", "SSR bundle"]) {
    check(
      `The registered controllers' markers and @strata-sc/analog are absent from ${label} output`,
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
    "No @strata-sc/h3 code is in any output (the Analog adapter does not use it)",
    markerScans.every((scan) => scan.h3AdapterSymbol.length === 0),
    markerScans.flatMap((scan) => scan.h3AdapterSymbol).join(", "),
  );
  check(
    "@strata-sc/core internals are absent from client output",
    scanOf("client").coreInternalSymbol.length === 0 &&
      scanOf("public").coreInternalSymbol.length === 0,
    "dist/client and dist/analog/public",
  );

  // ---- Dev server ----
  console.log("Baseline — dev server…");
  const dev = await withDevServer("Dev server", {}, (baseUrl) => observeRoutes(baseUrl, true));

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
    "GET /api/strata/users (registered by @strata-sc/analog) returns 200 JSON in the dev server",
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
  for (const { label, observed } of dev.methods) {
    check(
      `${label} reaches its own Strata handler with the right method/params/body in the dev server`,
      observed.ok,
      `${observed.status} ${observed.contentType} ${observed.body}`,
    );
  }
  for (const [index, observed] of dev.validation.entries()) {
    check(
      `Standard Schema validation case ${index + 1} works in the dev server`,
      observed.ok,
      `${observed.status} ${observed.contentType} ${observed.body}`,
    );
  }
  check(
    "24 overlapping mixed valid and invalid validation requests remain isolated in the dev server",
    dev.validationConcurrency,
    "per-request params, query, transformed body, safe error and private canary checks",
  );
  check(
    "JSON body failures return real 400/413/415 no-store responses in the dev server",
    dev.validationBodyPolicy,
    "malformed JSON, text/plain and >1 MiB JSON",
  );
  check(
    "24 overlapping synthetic guard requests preserve public, 401, 403 and owner access in the dev server",
    dev.guardContract,
    dev.guardDetail || "opaque fixture tokens and denial non-disclosure",
  );
  check(
    "Inventory HTTP contract and protected mutation behavior work in the dev server",
    dev.inventoryContract,
    dev.inventoryDetail || "safe errors, validated bodies, 201, patch and bodyless 204",
  );
  check(
    "HTTP routing and API boundary contract (JSON 404, 405 + Allow, HEAD, OPTIONS, native routes, 24 overlapping requests) works in the dev server",
    dev.routingContract,
    dev.routingDetail || "owned /api namespace, native routes not shadowed, pages stay HTML",
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
    pipeline: "Strata controller via `@strata-sc/analog` (`nitroApp.router`)",
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
    "Recorded seam outcome is B (H3 v1 app, no `.on`; @strata-sc/h3 needs `.on`)",
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
          ...observed.methods.map(({ label, observed: method }) => routeRow(label, mode, method)),
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
        "v1 `Router`, not an H3 v2 `H3` instance. The current `@strata-sc/h3` cannot mount directly.",
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
