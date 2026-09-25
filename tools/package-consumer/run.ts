import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run } from "../consumer/lib/exec.ts";
import type { CommandResult } from "../consumer/lib/exec.ts";
import { copyDirRecursive, findScopedPackageDirs } from "../consumer/lib/fs-helpers.ts";
import {
  assertPublishSelection,
  describeTarball,
  inspectTarball,
  packPackage,
  PUBLISHABLE_PACKAGES,
  readManifest,
} from "../release/lib/packages.ts";

/**
 * Packed-package consumer smoke: builds and packs @strata-sc/core and
 * @strata-sc/analog, installs the tarballs into an isolated consumer outside the
 * workspace, compiles consumer-authored controllers with TypeScript 5.9.2
 * (standard decorators, strict, skipLibCheck: false) and runs them on an H3 v1
 * router, the router Nitro 2 exposes to Analog.
 */

const TYPESCRIPT_VERSION = "5.9.2";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const fixtureDir = join(repoRoot, "tests", "package-consumer", "fixture");

class SmokeFailure extends Error {}

function step(label: string): void {
  console.log(`\n[test:package-consumer] ${label}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message);
}

function checkCommand(label: string, result: CommandResult): CommandResult {
  check(
    result.status === 0,
    `${label} failed (exit ${result.status}):\n${result.stdout}${result.stderr}`,
  );

  return result;
}

/** Drops pnpm/npm script variables so the consumer's npm sees no workspace config. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|NODE_PATH$|NODE_OPTIONS$)/i.test(key)) continue;
    env[key] = value;
  }

  return env;
}

const tmpRoot = mkdtempSync(join(tmpdir(), "strata-package-consumer-"));
let passed = false;

try {
  assertPublishSelection(PUBLISHABLE_PACKAGES);

  // --- Build + pack --------------------------------------------------------
  step("Building @strata-sc/core and @strata-sc/analog");
  checkCommand(
    "pnpm build",
    run(
      "pnpm",
      [...PUBLISHABLE_PACKAGES.flatMap(({ name }) => ["--filter", name]), "run", "build"],
      { cwd: repoRoot },
    ),
  );

  step("Packing tarballs");
  const tarballDir = join(tmpRoot, "tarballs");
  mkdirSync(tarballDir, { recursive: true });
  const tarballs = new Map<string, string>();

  for (const pkg of PUBLISHABLE_PACKAGES) {
    const tarballPath = packPackage(repoRoot, pkg, tarballDir);
    const inspection = inspectTarball(repoRoot, tarballPath);

    console.log(describeTarball(inspection));
    check(
      inspection.problems.length === 0,
      `${pkg.name} tarball is not externally installable:\n- ${inspection.problems.join("\n- ")}`,
    );
    tarballs.set(pkg.name, tarballPath);
  }

  const coreVersion = readManifest(join(repoRoot, "packages", "core")).version;
  const analogVersion = readManifest(join(repoRoot, "packages", "analog")).version;

  // --- Isolated consumer ---------------------------------------------------
  step(`Installing tarballs into isolated consumer ${tmpRoot}/consumer`);
  const consumerDir = join(tmpRoot, "consumer");
  copyDirRecursive(fixtureDir, consumerDir);

  const consumerManifestPath = join(consumerDir, "package.json");
  const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, tarballPath] of tarballs) {
    consumerManifest.dependencies[name] = `file:${tarballPath}`;
  }
  writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);

  const env = isolatedEnv();
  checkCommand(
    "npm install",
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
      cwd: consumerDir,
      env,
    }),
  );

  const nodeModules = join(consumerDir, "node_modules");
  const installedTypescript = readManifest(join(nodeModules, "typescript")).version;
  check(
    installedTypescript === TYPESCRIPT_VERSION,
    `consumer installed typescript@${installedTypescript}, expected ${TYPESCRIPT_VERSION}`,
  );

  for (const [name, version] of [
    ["@strata-sc/core", coreVersion],
    ["@strata-sc/analog", analogVersion],
  ] as const) {
    const installedDir = join(nodeModules, name);
    check(
      !lstatSync(installedDir).isSymbolicLink(),
      `${name} is a symlink, not an installed tarball`,
    );
    check(readManifest(installedDir).version === version, `${name} installed at the wrong version`);
    check(!existsSync(join(installedDir, "src")), `${name} install contains source files`);
  }

  const coreCopies = findScopedPackageDirs(nodeModules, "@strata-sc", "core");
  check(
    coreCopies.length === 1,
    `expected 1 @strata-sc/core copy, found:\n${coreCopies.join("\n")}`,
  );
  check(
    !existsSync(join(nodeModules, "@strata-sc", "h3")),
    "@strata-sc/h3 was installed into the consumer",
  );
  console.log(
    `installed: typescript@${installedTypescript}, @strata-sc/core@${coreVersion}, @strata-sc/analog@${analogVersion}, single core copy`,
  );

  // --- TypeScript 5.9.2 strict compile --------------------------------------
  const tsc = join(nodeModules, ".bin", "tsc");
  const consumerRealDir = realpathSync(consumerDir);
  const repoRealDir = realpathSync(repoRoot);

  // Controllers only, Node lib without DOM: every declaration diagnostic here
  // would come from @strata-sc/core, @strata-sc/analog or their dependency graph.
  step(`Typechecking Strata declaration graph with TypeScript ${TYPESCRIPT_VERSION} (no DOM lib)`);
  const strataOnly = checkCommand(
    "tsc -p tsconfig.strata.json",
    run(tsc, ["-p", "tsconfig.strata.json", "--listFiles"], { cwd: consumerDir, env }),
  );
  const strataGraph = strataOnly.stdout
    .trim()
    .split("\n")
    .filter((file) => file.includes("/node_modules/") && !file.includes("/typescript/lib/"));
  check(
    strataGraph.every((file) =>
      /\/node_modules\/(@strata-sc|@types\/node|undici-types)\//.test(file),
    ),
    `unexpected declarations in the Strata graph:\n${strataGraph.join("\n")}`,
  );
  console.log(
    `0 diagnostics; graph = @strata-sc/* + @types/node only (${strataGraph.filter((file) => file.includes("/@strata-sc/")).length} @strata-sc declaration files)`,
  );

  // The whole app also pulls in the H3 v1 harness. With skipLibCheck: false,
  // every diagnostic must come from h3's own declarations, never from
  // @strata-sc/* or consumer code.
  step("Attributing whole-app declaration diagnostics (skipLibCheck: false)");
  const fullLibCheck = run(tsc, ["-p", "tsconfig.json", "--noEmit", "--skipLibCheck", "false"], {
    cwd: consumerDir,
    env,
  });
  const fullDiagnostics = fullLibCheck.stdout
    .split("\n")
    .filter((line) => line.includes("error TS"));
  const nonH3Diagnostics = fullDiagnostics.filter((line) => !line.startsWith("node_modules/h3/"));
  check(
    nonH3Diagnostics.length === 0,
    `declaration diagnostics outside h3:\n${nonH3Diagnostics.join("\n")}`,
  );
  console.log(
    `${fullDiagnostics.length} diagnostic(s), all in node_modules/h3 (harness router); 0 in @strata-sc/* or consumer code`,
  );

  step(`Compiling with TypeScript ${TYPESCRIPT_VERSION} (NodeNext, strict)`);
  const compile = checkCommand(
    "tsc -p tsconfig.json",
    run(tsc, ["-p", "tsconfig.json", "--listFiles"], { cwd: consumerDir, env }),
  );
  const compiledFiles = compile.stdout.trim().split("\n").filter(Boolean);

  for (const name of ["core", "analog"]) {
    const declaration = join(
      consumerRealDir,
      "node_modules",
      "@strata-sc",
      name,
      "dist",
      "index.d.ts",
    );
    check(
      compiledFiles.some((file) => realpathSafe(file) === declaration),
      `tsc did not check ${declaration}`,
    );
  }
  check(
    !compiledFiles.some((file) => realpathSafe(file).startsWith(`${repoRealDir}/`)),
    "tsc resolved files from the Strata workspace",
  );
  const strataDeclarations = compiledFiles
    .filter((file) => file.includes("/@strata-sc/"))
    .map((file) => realpathSafe(file).replace(`${consumerRealDir}/`, ""));
  console.log(
    `0 diagnostics; @strata-sc declarations checked:\n  ${strataDeclarations.join("\n  ")}`,
  );

  step("Typechecking with Bundler resolution + DOM lib (Analog/Vite-style)");
  checkCommand(
    "tsc -p tsconfig.bundler.json",
    run(tsc, ["-p", "tsconfig.bundler.json"], { cwd: consumerDir, env }),
  );
  console.log("0 diagnostics");

  const emittedController = readFileSync(join(consumerDir, "dist", "posts.controller.js"), "utf8");
  check(
    emittedController.includes("__esDecorate") &&
      !/__decorate\(|__metadata\(/.test(emittedController),
    "emitted controller does not use standard (TC39) decorators",
  );
  console.log(
    "emitted controller uses standard decorators (__esDecorate), no legacy __decorate/__metadata",
  );

  // --- Runtime --------------------------------------------------------------
  step("Running consumer on an H3 v1 router");
  const execution = checkCommand(
    "node dist/main.js",
    run(process.execPath, [join("dist", "main.js")], { cwd: consumerDir, env }),
  );
  check(
    execution.stdout.includes("PACKAGE_CONSUMER_OK"),
    `runtime smoke did not pass:\n${execution.stdout}`,
  );

  const resultLine = execution.stdout
    .split("\n")
    .find((line) => line.startsWith("PACKAGE_CONSUMER_RESULT "));
  check(resultLine, "runtime smoke printed no result");
  const result = JSON.parse(resultLine.slice("PACKAGE_CONSUMER_RESULT ".length)) as {
    strataVersion: string;
    resolved: Record<string, string>;
    requests: number;
    cleanups: number;
  };
  const nodeModulesUrl = pathToFileURL(join(consumerRealDir, "node_modules")).href;

  check(
    result.strataVersion === coreVersion,
    `STRATA_VERSION ${result.strataVersion} != ${coreVersion}`,
  );
  for (const [name, url] of Object.entries(result.resolved)) {
    check(
      url.startsWith(`${nodeModulesUrl}/@strata-sc/`),
      `@strata-sc/${name} resolved outside the consumer: ${url}`,
    );
  }
  console.log(
    `registration, GET, params, query, per-request creation, isolation (concurrent), LIFO cleanup incl. error path: pass (${result.requests} requests, ${result.cleanups} cleanups)`,
  );

  passed = true;
} catch (error) {
  console.error(
    `\n[test:package-consumer] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  if (passed) {
    rmSync(tmpRoot, { recursive: true, force: true });
    console.log("\n[test:package-consumer] PASS");
  } else {
    console.error(`[test:package-consumer] Temporary workspace left for inspection: ${tmpRoot}`);
    process.exitCode = 1;
  }
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
