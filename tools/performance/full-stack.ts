import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";
import {
  inspectTarball,
  packPackage,
  readManifest,
  REGISTRY_PACKAGES,
} from "../release/lib/packages.ts";
import { check, repoRoot, section } from "../server-components/lib/harness.ts";
import {
  findInstalledCopies,
  installedVersion,
  isolatedEnv,
  isSymlinkAnywhere,
  readTarball,
  startWrangler,
} from "../server-components/lib/package-consumer.ts";
import { COMPATIBILITY_DATE } from "../server-components/lib/wrangler.ts";

import { ARMS, assembleArm, parseIslandCount, strataPackagesOf } from "./lib/arms.ts";
import type { ArmId, ArmSpec } from "./lib/arms.ts";
import { measureTarget, startNodeServer, timedGet } from "./lib/bench.ts";
import type { Target } from "./lib/bench.ts";
import {
  MARKERS,
  apiProblems,
  baselineIsolationProblems,
  boundaryProblems,
  browserStrataProblems,
  canaryProblems,
  confidentialityProblems,
  exactJsonProblems,
  hasStrataBoundary,
  islandsFor,
  lockTuple,
  ssrProblems,
  tupleMismatches,
} from "./lib/contract.ts";
import { entryScriptOf, measureBuild, scanMarkers, scanTargets } from "./lib/graph.ts";
import type { BuildMeasurement, Preset } from "./lib/graph.ts";
import { COMPRESSION } from "./lib/metrics.ts";
import {
  PRESET_OF,
  PRESETS,
  RUNTIMES,
  SCHEMA_VERSION,
  renderMarkdown,
  validateReport,
} from "./lib/report.ts";
import type {
  ArmReport,
  HttpRepetition,
  NegativeControl,
  PerfReport,
  PresetReport,
  Runtime,
} from "./lib/report.ts";
import { browserSmoke, islandsSmoke } from "./lib/smoke.ts";
import type { IslandFault } from "./lib/smoke.ts";

/**
 * `pnpm test:full-stack-performance`: the controlled full-stack performance and bundle-cost
 * baseline. ONE small Angular/Analog application in four arms (native, controllers,
 * Server Components, both), built from the PACKED Strata tarballs outside the workspace,
 * measured on the Nitro node-server output and on local Wrangler/workerd.
 * (docs/research/full-stack-performance-baseline.md)
 *
 * It asserts correctness strictly and performance NOT AT ALL: no latency or size threshold
 * exists. Output: report.json + summary.md in the evidence directory (printed at the end).
 *
 * Environment overrides (all recorded in the report):
 *   STRATA_PERF_REPS (3)  STRATA_PERF_BUILD_REPS (3)  STRATA_PERF_REQUESTS (200)
 *   STRATA_PERF_WARMUP (50)  STRATA_PERF_CONCURRENCY (8)  STRATA_PERF_OUT  STRATA_PERF_KEEP=1
 *   STRATA_PERF_NATIVE_HANDLER=object (diagnostic: idiomatic h3 object-return native route)
 *   STRATA_PERF_ISLANDS=1|3 (1): interactive client islands in all four arms; any other value fails.
 *     3 = three distinct island components (availability, stock, delivery), measured on the same
 *     arms and method. (docs/research/full-stack-performance-scaling.md)
 */

const integer = (name: string, fallback: number): number => {
  const value = process.env[name];

  if (value === undefined || value === "") return fallback;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);

  return parsed;
};

const islands = parseIslandCount(process.env["STRATA_PERF_ISLANDS"]);

const policy = {
  repetitions: integer("STRATA_PERF_REPS", 3),
  buildRepetitions: integer("STRATA_PERF_BUILD_REPS", 3),
  requests: integer("STRATA_PERF_REQUESTS", 200),
  warmup: integer("STRATA_PERF_WARMUP", 50),
  concurrency: integer("STRATA_PERF_CONCURRENCY", 8),
};

/** Williams design for four arms: each arm is first once, and every arm follows every other once. */
const ORDERS: readonly (readonly ArmId[])[] = [
  ["A", "B", "C", "D"],
  ["B", "D", "A", "C"],
  ["D", "C", "B", "A"],
  ["C", "A", "D", "B"],
];
const orderFor = (index: number): readonly ArmId[] => ORDERS[index % ORDERS.length]!;
const armById = (id: ArmId): ArmSpec => ARMS.find((arm) => arm.id === id)!;

const TARGETS: Record<"api" | "ssr", Target> = {
  api: { name: "api", path: "/api/products/42", validate: apiProblems },
  ssr: { name: "ssr", path: "/products/42", validate: (outcome) => ssrProblems(outcome, islands) },
};

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-full-stack-performance-"));
const evidenceDir =
  process.env["STRATA_PERF_OUT"] ?? mkdtempSync(join(tmpdir(), "strata-perf-evidence-"));
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");

writeFileSync(emptyNpmrc, "");
writeFileSync(emptyGlobalNpmrc, "");

const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sha512Integrity = (path: string): string =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
const sanitize = (text: string): string => stripVTControlCharacters(text);

class Abort extends Error {}

function must(result: { status: number; stdout: string; stderr: string }, label: string): void {
  if (
    !check(
      `${label} exits 0`,
      result.status === 0,
      sanitize(result.stderr || result.stdout).slice(-2_500),
    )
  )
    throw new Abort(label);
}

mkdirSync(evidenceDir, { recursive: true });
console.log(`evidence directory: ${evidenceDir}`);
console.log(`working directory (removed afterwards unless STRATA_PERF_KEEP=1): ${tmpRoot}`);
console.log(`policy: ${JSON.stringify(policy)}`);
console.log(`islands: ${islands}`);

// ---------------------------------------------------------------------------
// 1. Pack the three real packages

interface Tarball {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly sha256: string;
  readonly integrity: string;
  readonly bytes: number;
  readonly extractedDir: string;
}

function packStrata(): Tarball[] {
  section("Build and pack the three real packages (pnpm pack, never published)");

  for (const pkg of REGISTRY_PACKAGES)
    rmSync(join(repoRoot, pkg.dir, "dist"), { recursive: true, force: true });
  must(
    run("pnpm", [...REGISTRY_PACKAGES.flatMap(({ name }) => ["--filter", name]), "run", "build"], {
      cwd: repoRoot,
    }),
    "pnpm build (core, analog, server-components)",
  );

  const dir = join(tmpRoot, "tarballs");

  mkdirSync(dir, { recursive: true });

  return REGISTRY_PACKAGES.map((pkg) => {
    const path = packPackage(repoRoot, pkg, dir);
    const inspection = inspectTarball(repoRoot, path);
    const extractedDir = join(tmpRoot, "extracted", pkg.dir.replace("packages/", ""));
    const extracted = readTarball(path, extractedDir);
    const version = readManifest(join(repoRoot, pkg.dir)).version;

    check(
      `${pkg.name}@${version}: release inspector reports 0 problems`,
      inspection.problems.length === 0,
      inspection.problems.join("; "),
    );
    check(
      `${pkg.name}: the packed manifest version equals the repository manifest`,
      extracted.manifest.version === version,
    );

    const entry = {
      name: pkg.name,
      version,
      path,
      sha256: sha256(path),
      integrity: sha512Integrity(path),
      bytes: inspection.sizeBytes,
      extractedDir,
    };

    console.log(`tarball: ${pkg.name}@${version}  ${entry.bytes} bytes  sha256 ${entry.sha256}`);

    return entry;
  });
}

// ---------------------------------------------------------------------------
// 2. Assemble, install and verify each arm

interface ArmState {
  readonly spec: ArmSpec;
  readonly dir: string;
  readonly sources: Record<string, string>;
  tuple: Record<string, string>;
  lockKeys: string[];
  installedScopes: string[];
  manifestDependencies: Record<string, string>;
  readonly problems: string[];
}

const template = join(repoRoot, "tests", "full-stack-performance", "fixture");

function installArm(spec: ArmSpec, tarballs: readonly Tarball[]): ArmState {
  const dir = join(tmpRoot, `arm-${spec.id}`);

  mkdirSync(dir, { recursive: true });
  section(`Arm ${spec.id} (${spec.label}): assemble and install`);

  const assembled = assembleArm({
    template,
    destination: dir,
    arm: spec,
    tarballs: Object.fromEntries(tarballs.map((t) => [t.name, t.path])),
    nativeStyle: process.env["STRATA_PERF_NATIVE_HANDLER"] === "object" ? "object" : "response",
    islands,
  });

  // npm 10's peer-dependency resolver crashes (`Cannot read properties of null (reading
  // 'edgesOut')`) on the current registry state for @angular/build's optional vitest peer, as it
  // does for every existing external consumer on main. All required peers are declared directly,
  // so the tuple is exactly the declared one.
  const install = run(
    "npm",
    ["install", "--legacy-peer-deps", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: dir, env },
  );

  must(install, `arm ${spec.id}: npm install`);

  const problems: string[] = [];
  const expected = strataPackagesOf(spec);
  const installedScopes = existsSync(join(dir, "node_modules", "@strata-sc"))
    ? readdirSync(join(dir, "node_modules", "@strata-sc")).map((name) => `@strata-sc/${name}`)
    : [];
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };

  for (const tarball of tarballs) {
    const wanted = expected.includes(tarball.name);
    const installed = join(dir, "node_modules", tarball.name);

    if (!wanted) {
      problems.push(
        ...(existsSync(installed)
          ? [`${tarball.name} is installed in an arm that must not have it`]
          : []),
      );
      check(`arm ${spec.id}: ${tarball.name} is NOT installed`, !existsSync(installed));
      continue;
    }

    const packed = listFiles(tarball.extractedDir);
    const differing = packed.filter(
      (file) =>
        !existsSync(join(installed, file)) ||
        sha256(join(installed, file)) !== sha256(join(tarball.extractedDir, file)),
    );
    const entry = lock.packages[`node_modules/${tarball.name}`];
    const identity = [
      existsSync(join(installed, "package.json")) &&
        !isSymlinkAnywhere(installed) &&
        lstatSync(installed).isDirectory(),
      installedVersion(dir, tarball.name) === tarball.version,
      differing.length === 0,
      !existsSync(join(installed, "src")),
      entry?.resolved?.startsWith("file:") === true && entry.integrity === tarball.integrity,
      findInstalledCopies(dir, tarball.name).length === 1,
    ];

    if (
      !check(
        `arm ${spec.id}: ${tarball.name}@${tarball.version} is the packed tarball (real directory, byte-identical, lock sha512, single copy)`,
        identity.every(Boolean),
        `${identity.join(",")} ${differing.join(",")}`,
      )
    )
      problems.push(`${tarball.name} identity`);
  }

  check(
    `arm ${spec.id}: exactly [${expected.join(", ") || "no Strata package"}] installed`,
    installedScopes.slice().sort().join(",") === [...expected].sort().join(","),
    installedScopes.join(","),
  );
  check(
    `arm ${spec.id}: no lock entry resolves a @strata-sc package from a registry`,
    Object.entries(lock.packages)
      .filter(([key]) => key.includes("@strata-sc/"))
      .every(([, value]) => value.resolved?.startsWith("file:") === true),
  );
  check(
    `arm ${spec.id}: one installed copy each of @angular/core, @angular/compiler and typescript`,
    ["@angular/core", "@angular/compiler", "typescript"].every(
      (name) => findInstalledCopies(dir, name).length === 1,
    ),
  );

  // `--legacy-peer-deps` leaves Analog's markdown/content peers (unused: no content routes) and
  // optional wasm fallbacks uninstalled. Anything else npm ls reports is a real tuple problem.
  const ANALOG_CONTENT_PEER =
    /^missing: (marked[\w-]*|@analogjs\/content)@\S+, required by @analogjs\/(platform|router)@/;
  const listed = run("npm", ["ls", "--all", "--json"], { cwd: dir, env });
  const npmProblems = (
    (JSON.parse(listed.stdout || "{}") as { problems?: string[] }).problems ?? []
  ).filter((problem) => !problem.startsWith("extraneous:") && !ANALOG_CONTENT_PEER.test(problem));

  check(
    `arm ${spec.id}: npm ls reports no unexpected missing or invalid package`,
    npmProblems.length === 0,
    npmProblems.join("; "),
  );

  const sources: Record<string, string> = {};

  for (const file of assembled.files.filter((f) => f.endsWith(".ts") || f === "package.json"))
    sources[file] = readFileSync(join(dir, file), "utf8");

  return {
    spec,
    dir,
    sources,
    tuple: lockTuple(lock.packages),
    lockKeys: Object.keys(lock.packages),
    installedScopes,
    manifestDependencies: assembled.dependencies,
    problems: [...problems, ...npmProblems.map((p) => `npm ls: ${p}`)],
  };
}

// ---------------------------------------------------------------------------
// 3. Builds

const viteBin = (state: ArmState): string =>
  join(state.dir, "node_modules", "vite", "bin", "vite.js");

function cleanBuild(state: ArmState): void {
  for (const path of [
    "dist",
    "src/generated",
    ".nitro",
    ".angular",
    "node_modules/.vite",
    "node_modules/.cache",
  ])
    rmSync(join(state.dir, path), { recursive: true, force: true });
}

interface BuildRecord {
  readonly measurements: BuildMeasurement[];
  readonly buildMs: number[];
  readonly problems: string[];
}

const builds = new Map<string, BuildRecord>();
const buildKey = (id: ArmId, preset: Preset): string => `${id}:${preset}`;
const runDirOf = (id: ArmId, preset: Preset): string => join(tmpRoot, "runs", `${id}-${preset}`);

/** Prepares an isolated copy of the last build so builds of the other preset cannot overwrite it. */
function stageRun(state: ArmState, preset: Preset): void {
  const dir = runDirOf(state.spec.id, preset);

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(state.dir, "dist"), join(dir, "dist"), { recursive: true });
  symlinkSync(join(state.dir, "node_modules"), join(dir, "node_modules"), "dir");
}

function buildAll(states: ReadonlyMap<ArmId, ArmState>): void {
  section(
    `Production builds: ${policy.buildRepetitions} fresh build(s) per arm and preset, order rotated`,
  );

  for (let rep = 0; rep < policy.buildRepetitions; rep++) {
    for (const preset of PRESETS) {
      for (const id of orderFor(rep)) {
        const state = states.get(id)!;
        const record = builds.get(buildKey(id, preset)) ?? {
          measurements: [],
          buildMs: [],
          problems: [],
        };

        builds.set(buildKey(id, preset), record);
        cleanBuild(state);

        const started = performance.now();
        const result = run(process.execPath, [viteBin(state), "build"], {
          cwd: state.dir,
          env: {
            ...env,
            ...(preset === "cloudflare-pages"
              ? { BUILD_PRESET: "cloudflare-pages" }
              : { BUILD_PRESET: "" }),
          },
        });
        const elapsed = performance.now() - started;

        if (
          !check(
            `arm ${id} ${preset} build ${rep + 1}/${policy.buildRepetitions} exits 0 (${(elapsed / 1000).toFixed(1)} s)`,
            result.status === 0,
            sanitize(result.stderr || result.stdout).slice(-1_500),
          )
        ) {
          record.problems.push(`build ${rep + 1} failed`);
          continue;
        }

        const root = join(state.dir, "dist", "analog");
        const meta = JSON.parse(readFileSync(join(root, "nitro.json"), "utf8")) as {
          preset?: string;
        };

        if (meta.preset !== preset) {
          record.problems.push(`build resolved preset ${meta.preset}, expected ${preset}`);
          check(`arm ${id}: build resolves the ${preset} preset`, false, String(meta.preset));
          continue;
        }

        const html = readFileSync(join(root, "public", "index.html"), "utf8");
        const entryScript = entryScriptOf(html);

        if (entryScript === undefined) {
          record.problems.push("no browser entry script in the SSR template");
          continue;
        }

        record.buildMs.push(elapsed);
        record.measurements.push(measureBuild({ root, preset, entryScript }));

        if (rep === policy.buildRepetitions - 1) stageRun(state, preset);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Correctness preflight (static)

const ALL_MARKERS = Object.values(MARKERS);

function staticProblems(
  state: ArmState,
  preset: Preset,
  root: string,
  measurement: BuildMeasurement | undefined,
): string[] {
  const targets = scanTargets(root, preset);
  const scan = {
    server: scanMarkers(targets.server, ALL_MARKERS),
    browser: scanMarkers(targets.browser, ALL_MARKERS),
  };
  const problems = confidentialityProblems(state.spec, scan, islands);

  if (measurement)
    problems.push(
      ...browserStrataProblems(state.spec, Object.keys(measurement.browser.sourceModulesByPackage)),
    );

  if (!usesStrataAt(state.spec)) {
    const built: Record<string, string> = {};

    for (const file of [...targets.browser, ...targets.server]) {
      if (/\.(m?js|html)$/.test(file))
        built[file.slice(root.length + 1)] = readFileSync(file, "utf8");
    }

    problems.push(
      ...baselineIsolationProblems({
        manifestDependencies: state.manifestDependencies,
        sources: state.sources,
        lockKeys: state.lockKeys,
        installedScopes: state.installedScopes,
        built,
      }),
    );
  }

  return problems;
}

const usesStrataAt = (spec: ArmSpec): boolean => strataPackagesOf(spec).length > 0;

// ---------------------------------------------------------------------------
// 5. Running servers

interface Running {
  readonly baseUrl: string;
  readonly startupMs?: number;
  rssKiB(): number | null;
  output(): string;
  stop(): Promise<void>;
}

async function start(runtime: Runtime, runDir: string): Promise<Running> {
  if (runtime === "node") {
    const server = await startNodeServer({ cwd: runDir, env, readyPath: "/api/products/42" });

    return server;
  }

  const server = await startWrangler(runDir, env, "/api/products/42");

  return {
    baseUrl: server.baseUrl,
    rssKiB: () => null,
    output: () => server.output(),
    stop: () => server.stop(),
  };
}

/** Public contract and Strata-boundary checks against one running server. */
async function httpProblems(spec: ArmSpec, base: string): Promise<string[]> {
  const problems: string[] = [];
  const api = await timedGet(`${base}/api/products/42`);
  const ssr = await timedGet(`${base}/products/42`);
  const missing = await timedGet(`${base}/api/products/999`);
  const home = await timedGet(`${base}/`);
  const headers = await fetch(`${base}/api/products/42`).then((response) => ({
    handler: response.headers.get("x-perf-handler"),
    type: response.headers.get("content-type"),
    cache: response.headers.get("cache-control"),
  }));

  problems.push(...apiProblems(api).map((p) => `API: ${p}`));
  problems.push(...ssrProblems(ssr, islands).map((p) => `SSR: ${p}`));
  problems.push(...canaryProblems("SSR document", ssr.body));
  problems.push(...canaryProblems("API response", api.body));

  if (islands === 1) {
    if (hasStrataBoundary(ssr.body) !== (spec.page === "server-component"))
      problems.push(
        `SSR: Strata boundary markup ${hasStrataBoundary(ssr.body) ? "present" : "absent"} unexpectedly`,
      );
  } else {
    problems.push(
      ...boundaryProblems(ssr.body, spec.page === "server-component", islands).map(
        (p) => `SSR: ${p}`,
      ),
    );
  }

  // The extra islands' public endpoints: same contract in all four arms, unknown product is a 404.
  for (const island of islandsFor(islands).slice(1)) {
    const answer = await timedGet(`${base}${island.apiPath}`);
    const unknown = await timedGet(`${base}${island.apiPath.replace("/42", "/999")}`);

    problems.push(
      ...exactJsonProblems(answer, island.apiBody).map((p) => `${island.id} API: ${p}`),
    );
    problems.push(...canaryProblems(`${island.id} API response`, answer.body));
    if (unknown.status !== 404 || !unknown.body.includes("not_found"))
      problems.push(`${island.id} API: unknown product answered ${unknown.status}`);
  }
  if (missing.status !== 404 || !missing.body.includes("not_found"))
    problems.push(`unknown product answered ${missing.status}`);
  if (home.status !== 200) problems.push(`home answered ${home.status}`);
  if (!headers.type?.startsWith("application/json"))
    problems.push(`API content-type ${headers.type}`);
  if (headers.cache !== "no-store") problems.push(`API cache-control ${headers.cache}`);
  if (headers.handler !== (spec.api === "controller" ? MARKERS.controller : MARKERS.native))
    problems.push(`API served by ${headers.handler}`);

  return problems;
}

// ---------------------------------------------------------------------------
// 6. Measurement loops

function prepareArm(
  spec: ArmSpec,
  states: ReadonlyMap<ArmId, ArmState>,
): {
  report: Omit<ArmReport, "http" | "browserSmoke" | "correctness" | "ssrDocumentBytes">;
  problems: string[];
} {
  const state = states.get(spec.id)!;
  const problems = [...state.problems];
  const presets = Object.fromEntries(
    PRESETS.map((preset) => {
      const record = builds.get(buildKey(spec.id, preset))!;
      const last = record.measurements.at(-1);
      // Raw bytes only: compressed server sizes shift by ~10 B because chunk hashes occur in imports.
      const fingerprint = (m: BuildMeasurement): string =>
        JSON.stringify([
          m.browser.js.raw,
          m.browser.initialEntry.raw,
          m.server.bundledJs.raw,
          m.server.entryReachable.raw,
          m.deployable.bytes,
        ]);
      const deterministic =
        record.measurements.length > 1 &&
        record.measurements.every((m) => fingerprint(m) === fingerprint(last!));

      if (!deterministic && record.measurements.length > 1)
        console.log(
          `  nondeterministic ${spec.id} ${preset}: ${record.measurements.map(fingerprint).join("\n    vs ")}`,
        );

      problems.push(...record.problems.map((p) => `${preset}: ${p}`));

      if (record.measurements.length !== policy.buildRepetitions)
        problems.push(`${preset}: only ${record.measurements.length} successful build(s)`);

      const confidentiality = last
        ? staticProblems(state, preset, join(runDirOf(spec.id, preset), "dist", "analog"), last)
        : ["no build to inspect"];

      problems.push(...confidentiality.map((p) => `${preset}: ${p}`));
      check(
        `arm ${spec.id} ${preset}: build and confidentiality contract`,
        confidentiality.length === 0 && record.problems.length === 0,
        confidentiality.join("; "),
      );

      return [
        preset,
        {
          measurement: last!,
          buildMs: record.buildMs,
          deterministic: policy.buildRepetitions === 1 ? true : deterministic,
          confidentialityProblems: confidentiality,
        } satisfies PresetReport,
      ];
    }),
  ) as Record<Preset, PresetReport>;

  return {
    report: {
      id: spec.id,
      label: spec.label,
      page: spec.page,
      api: spec.api,
      strataPackages: strataPackagesOf(spec),
      builds: presets,
    },
    problems,
  };
}

async function measureRuntime(
  runtime: Runtime,
  http: Map<ArmId, HttpRepetition[]>,
  smoke: Map<string, { ok: boolean; problems: string[] }>,
  failed: Map<ArmId, string[]>,
  documentBytes: Map<string, number>,
): Promise<void> {
  section(
    `HTTP measurement on ${runtime}: ${policy.repetitions} repetition(s), ${policy.requests} requests per target and mode, warm-up ${policy.warmup}`,
  );

  const preset = PRESET_OF[runtime];

  for (let rep = 0; rep < policy.repetitions; rep++) {
    const order = orderFor(rep).filter((id) => !failed.has(id));
    const targets: ("api" | "ssr")[] = rep % 2 === 0 ? ["api", "ssr"] : ["ssr", "api"];

    for (const [position, id] of order.entries()) {
      const spec = armById(id);
      const server = await start(runtime, runDirOf(id, preset));

      try {
        const problems = await httpProblems(spec, server.baseUrl);

        if (rep === 0) {
          const smokeProblems =
            islands === 1
              ? await browserSmoke({ base: server.baseUrl })
              : await islandsSmoke({ base: server.baseUrl, islands });

          smoke.set(`${id}:${runtime}`, {
            ok: smokeProblems.length === 0,
            problems: smokeProblems,
          });
          problems.push(...smokeProblems.map((p) => `browser smoke: ${p}`));
          check(
            `arm ${id} ${runtime}: hydration and interaction smoke`,
            smokeProblems.length === 0,
            smokeProblems.join("; "),
          );
        }

        if (problems.length > 0) {
          failed.set(id, [...(failed.get(id) ?? []), ...problems.map((p) => `${runtime}: ${p}`)]);
          check(
            `arm ${id} ${runtime} repetition ${rep + 1}: correctness preflight`,
            false,
            problems.join("; "),
          );
          continue;
        }

        if (rep === 0)
          documentBytes.set(
            `${id}:${runtime}`,
            Buffer.byteLength((await timedGet(`${server.baseUrl}${TARGETS.ssr.path}`)).body),
          );

        const rssStart = server.rssKiB();
        const results = {} as Record<"api" | "ssr", Awaited<ReturnType<typeof measureTarget>>>;

        for (const name of targets)
          results[name] = await measureTarget(server.baseUrl, TARGETS[name], policy);

        const invalid = targets
          .flatMap((name) => [results[name].sequential.invalid, results[name].concurrent.invalid])
          .reduce((a, b) => a + b, 0);
        const warmupProblems = targets.flatMap((name) => results[name].warmup.problems);

        if (invalid > 0 || warmupProblems.length > 0) {
          failed.set(id, [
            ...(failed.get(id) ?? []),
            `${runtime}: ${invalid} invalid measured response(s); ${warmupProblems.join("; ")}`,
          ]);
          check(
            `arm ${id} ${runtime} repetition ${rep + 1}: every response valid`,
            false,
            `${invalid} invalid`,
          );
          continue;
        }

        const reps = http.get(id) ?? [];
        const entry: HttpRepetition = {
          repetition: rep,
          position,
          api: results.api,
          ssr: results.ssr,
          ...(runtime === "node" && "startupMs" in server && server.startupMs !== undefined
            ? {
                startupMs: server.startupMs,
                rssKiB: { afterStart: rssStart, afterLoad: server.rssKiB() },
              }
            : {}),
        };

        reps.push(entry);
        http.set(id, reps);
        console.log(
          `  ${runtime} rep ${rep + 1} #${position + 1} arm ${id}: API p50 ${results.api.sequential.p50?.toFixed(2)} ms, SSR p50 ${results.ssr.sequential.p50?.toFixed(2)} ms`,
        );
      } finally {
        await server.stop();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Negative controls (Node output of arm D, arm A sources, arm A tuple)

function copyRun(id: ArmId, label: string): string {
  const target = join(tmpRoot, "negative", label);

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(runDirOf(id, "node-server"), "dist"), join(target, "dist"), { recursive: true });
  symlinkSync(join(tmpRoot, `arm-${id}`, "node_modules"), join(target, "node_modules"), "dir");

  return target;
}

function replaceIn(files: readonly string[], from: string, to: string): number {
  let changed = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    if (!text.includes(from)) continue;
    writeFileSync(file, text.replaceAll(from, to));
    changed++;
  }

  return changed;
}

type RecordControl = (name: string, description: string, problems: readonly string[]) => void;

/** Controls that exist only where there are several islands: each breaks exactly ONE of them. */
async function islandNegativeControls(armD: ArmState, record: RecordControl): Promise<void> {
  const faults: readonly [string, string, IslandFault][] = [
    [
      "island-click-issues-no-request",
      "the delivery button's click never reaches its handler: no API request (arm D, Node)",
      { island: "delivery", kind: "swallow-click" },
    ],
    [
      "island-state-not-updated",
      "the stock island's API request is aborted: its state never updates (arm D, Node)",
      { island: "stock", kind: "block-api" },
    ],
  ];

  // One of three islands missing from the server render.
  const noStock = copyRun("D", "island-missing-from-ssr");
  const noStockRoot = join(noStock, "dist", "analog");

  replaceIn(scanTargets(noStockRoot, "node-server").server, "product-stock", "product-stocx");

  const noStockServer = await start("node", noStock);

  try {
    record(
      "island-missing-from-ssr",
      "one of three islands is not rendered by the server (arm D, Node)",
      await httpProblems(armD.spec, noStockServer.baseUrl),
    );
  } finally {
    await noStockServer.stop();
  }

  const intact = copyRun("D", "island-faults");
  const server = await start("node", intact);

  try {
    const html = (await timedGet(`${server.baseUrl}/products/42`)).body;
    const collided = html.replace(
      'data-strata-client="product-stock"',
      'data-strata-client="product-delivery"',
    );

    record(
      "island-boundary-identity-collision",
      "two islands share one boundary identity in the SSR document (arm D)",
      collided === html ? [] : boundaryProblems(collided, true, islands),
    );

    for (const [name, description, fault] of faults)
      record(
        name,
        description,
        await islandsSmoke({ base: server.baseUrl, islands, timeoutMs: 6_000, fault }),
      );
  } finally {
    await server.stop();
  }

  // Server-only canary of the added server module leaking into a browser chunk.
  const leak = copyRun("D", "browser-leak-warehouse");
  const leakRoot = join(leak, "dist", "analog");
  const [chunk] = scanTargets(leakRoot, "node-server").browser.filter((file) =>
    file.endsWith(".js"),
  );

  writeFileSync(chunk!, `${readFileSync(chunk!, "utf8")}\n/* ${MARKERS.privateWarehouse} */\n`);
  record(
    "browser-leak-warehouse",
    "the fulfilment canary appended to a browser chunk (arm D)",
    staticProblems(armD, "node-server", leakRoot, undefined),
  );
}

async function negativeControls(states: ReadonlyMap<ArmId, ArmState>): Promise<NegativeControl[]> {
  section("Negative controls: intentionally broken variants must be REJECTED, never measured");

  const controls: NegativeControl[] = [];
  const record = (name: string, description: string, problems: readonly string[]): void => {
    const rejected = problems.length > 0;

    controls.push({
      name,
      description,
      rejected,
      detail: problems.slice(0, 3).join("; ") || "NOT rejected",
    });
    check(
      `negative control "${name}" is rejected`,
      rejected,
      "the broken variant passed its preflight",
    );
  };
  const armD = states.get("D")!;

  // 1. Missing server implementation: the Server Component's marker vanishes from the server graph.
  const noImpl = copyRun("D", "missing-server-implementation");
  const noImplRoot = join(noImpl, "dist", "analog");

  replaceIn(
    scanTargets(noImplRoot, "node-server").server,
    MARKERS.implementation,
    "PERF_CONSUMER_IMPLEMENTATIOX_MARKER",
  );

  const noImplServer = await start("node", noImpl);

  try {
    record(
      "missing-server-implementation",
      "Server Component implementation removed from the server graph (arm D, Node)",
      [
        ...staticProblems(armD, "node-server", noImplRoot, undefined),
        ...(await httpProblems(armD.spec, noImplServer.baseUrl)),
      ],
    );
  } finally {
    await noImplServer.stop();
  }

  // 2. Missing browser functionality: the island's request goes nowhere.
  const noClient = copyRun("D", "missing-browser-functionality");
  const noClientRoot = join(noClient, "dist", "analog");
  const changed = replaceIn(
    scanTargets(noClientRoot, "node-server").browser,
    "/api/products/",
    "/api/nowhere1/",
  );
  const noClientServer = await start("node", noClient);

  try {
    record(
      "missing-browser-functionality",
      `island request target broken in ${changed} browser file(s) (arm D, Node)`,
      changed === 0
        ? []
        : islands === 1
          ? await browserSmoke({ base: noClientServer.baseUrl, timeoutMs: 6_000 })
          : await islandsSmoke({ base: noClientServer.baseUrl, islands, timeoutMs: 6_000 }),
    );
  } finally {
    await noClientServer.stop();
  }

  // 3. Missing island code in the browser output.
  const noIsland = copyRun("D", "missing-island");
  const noIslandRoot = join(noIsland, "dist", "analog");

  replaceIn(
    scanTargets(noIslandRoot, "node-server").browser,
    MARKERS.client,
    "PERF_CONSUMER_CLIENT_MARKEX",
  );
  record(
    "missing-island",
    "island marker removed from the browser output (arm D)",
    staticProblems(armD, "node-server", noIslandRoot, undefined),
  );

  // 4. Server-only code leaking into the browser output.
  const leak = copyRun("D", "browser-leak");
  const leakRoot = join(leak, "dist", "analog");
  const browserJs = scanTargets(leakRoot, "node-server").browser.filter((file) =>
    file.endsWith(".js"),
  );

  writeFileSync(
    browserJs[0]!,
    `${readFileSync(browserJs[0]!, "utf8")}\n/* ${MARKERS.privateNote} */\n`,
  );
  record(
    "browser-leak",
    "a private canary appended to a browser chunk (arm D)",
    staticProblems(armD, "node-server", leakRoot, undefined),
  );

  if (islands > 1) await islandNegativeControls(armD, record);

  // 5. A no-Strata baseline that accidentally imports a Strata package.
  const armA = states.get("A")!;
  const contaminated = {
    ...armA.sources,
    "src/server/catalog.ts": `import "@strata-sc/core";\n${armA.sources["src/server/catalog.ts"] ?? ""}`,
  };

  record(
    "contaminated-baseline",
    "arm A source importing @strata-sc/core",
    baselineIsolationProblems({
      manifestDependencies: armA.manifestDependencies,
      sources: contaminated,
      lockKeys: armA.lockKeys,
      installedScopes: armA.installedScopes,
      built: {},
    }),
  );

  // 6. A mismatched dependency tuple.
  const skewed = { ...armA.tuple };
  const victim = Object.keys(skewed).find((key) => key.endsWith("node_modules/rxjs"))!;

  skewed[victim] = "0.0.0 sha512-tampered";
  record(
    "mismatched-tuple",
    "one locked package differs between arms",
    tupleMismatches({ A: skewed, B: armD.tuple }),
  );

  return controls;
}

// ---------------------------------------------------------------------------
// Main

function git(...args: string[]): string {
  return run("git", args, { cwd: repoRoot }).stdout.trim();
}

async function main(): Promise<boolean> {
  const tarballs = packStrata();
  const states = new Map<ArmId, ArmState>();

  for (const spec of ARMS) states.set(spec.id, installArm(spec, tarballs));

  section("Dependency tuple: every arm resolves the identical non-Strata tree");

  const mismatches = tupleMismatches(
    Object.fromEntries(ARMS.map((spec) => [spec.id, states.get(spec.id)!.tuple])),
  );

  check(
    `all ${ARMS.length} arms lock the identical ${Object.keys(states.get("A")!.tuple).length} non-Strata package entries (versions and integrity)`,
    mismatches.length === 0,
    mismatches.slice(0, 5).join("; "),
  );

  const armA = states.get("A")!;
  const tupleNames = [
    "@angular/core",
    "@angular/compiler",
    "@angular/platform-server",
    "@angular/router",
    "@angular/build",
    "@analogjs/platform",
    "@analogjs/router",
    "@analogjs/vite-plugin-angular",
    "@analogjs/vite-plugin-nitro",
    "nitropack",
    "h3",
    "vite",
    "typescript",
    "rxjs",
    "tslib",
    "wrangler",
  ];
  const tuple = Object.fromEntries(
    tupleNames.map((name) => [name, installedVersion(armA.dir, name)]),
  );

  console.log(
    `tuple: ${Object.entries(tuple)
      .map(([k, v]) => `${k}@${v}`)
      .join(", ")}`,
  );

  buildAll(states);

  const http: Record<Runtime, Map<ArmId, HttpRepetition[]>> = {
    node: new Map(),
    workerd: new Map(),
  };
  const smoke = new Map<string, { ok: boolean; problems: string[] }>();
  const failed = new Map<ArmId, string[]>();
  const documentBytes = new Map<string, number>();
  const prepared = new Map(ARMS.map((spec) => [spec.id, prepareArm(spec, states)]));

  for (const [id, { problems }] of prepared) if (problems.length > 0) failed.set(id, problems);

  for (const runtime of RUNTIMES)
    await measureRuntime(runtime, http[runtime], smoke, failed, documentBytes);

  const controls = await negativeControls(states);
  const arms: ArmReport[] = ARMS.map((spec) => {
    const { report } = prepared.get(spec.id)!;
    const problems = failed.get(spec.id) ?? [];
    const ok = problems.length === 0;
    const reps = (runtime: Runtime): readonly HttpRepetition[] =>
      ok ? (http[runtime].get(spec.id) ?? []) : [];

    return {
      ...report,
      http: { node: reps("node"), workerd: reps("workerd") },
      ssrDocumentBytes: Object.fromEntries(
        RUNTIMES.map((runtime) => [runtime, documentBytes.get(`${spec.id}:${runtime}`) ?? null]),
      ) as ArmReport["ssrDocumentBytes"],
      browserSmoke: Object.fromEntries(
        RUNTIMES.map((runtime) => [
          runtime,
          smoke.get(`${spec.id}:${runtime}`) ?? { ok: false, problems: ["not run"] },
        ]),
      ) as ArmReport["browserSmoke"],
      correctness: { ok, problems },
    };
  });

  const overrides = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key.startsWith("STRATA_PERF_") && value !== undefined,
    ),
  ) as Record<string, string>;
  const report: PerfReport = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    islandCount: islands,
    baseline: {
      startingMainSha: git("merge-base", "HEAD", "origin/main"),
      headSha: git("rev-parse", "HEAD"),
      workingTreeClean: git("status", "--porcelain") === "",
    },
    environment: {
      os: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      node: process.version,
      npm: run("npm", ["--version"], { env }).stdout.trim(),
      wrangler: installedVersion(armA.dir, "wrangler"),
      compatibilityDate: COMPATIBILITY_DATE,
      overrides,
    },
    tuple,
    tupleIdentical: mismatches.length === 0,
    packages: tarballs.map(({ name, version, sha256: digest, bytes }) => ({
      name,
      version,
      sha256: digest,
      bytes,
    })),
    policy: {
      warmup: policy.warmup,
      requests: policy.requests,
      concurrency: policy.concurrency,
      repetitions: policy.repetitions,
      buildRepetitions: policy.buildRepetitions,
      compression: COMPRESSION,
      orders: Array.from(
        { length: Math.max(policy.repetitions, policy.buildRepetitions) },
        (_, i) => orderFor(i),
      ),
    },
    arms,
    negativeControls: controls,
  };

  section("Report");

  const problems = validateReport(report);

  check(
    "the JSON report is complete and self-consistent",
    problems.length === 0,
    problems.join("; "),
  );

  writeFileSync(join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "summary.md"), `${renderMarkdown(report)}\n`);
  console.log(`\n${renderMarkdown(report)}`);
  console.log(
    `\nreport: ${join(evidenceDir, "report.json")}\nsummary: ${join(evidenceDir, "summary.md")}`,
  );
  for (const arm of arms)
    if (!arm.correctness.ok)
      console.log(`arm ${arm.id} FAILED correctness: ${arm.correctness.problems.join("; ")}`);

  return problems.length === 0 && arms.every((arm) => arm.correctness.ok);
}

let ok = false;

try {
  ok = await main();
} catch (error) {
  console.error(error instanceof Abort ? `aborted: ${error.message}` : error);
} finally {
  if (process.env["STRATA_PERF_KEEP"] !== "1") rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(
  `\n${ok ? "PASS" : "FAIL"}: full-stack performance baseline (correctness only; no performance threshold exists)`,
);
process.exit(ok ? 0 : 1);
