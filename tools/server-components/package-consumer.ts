import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { httpGet } from "../analog/lib/process.ts";
import { listFiles } from "../analog/lib/scan.ts";
import { run } from "../consumer/lib/exec.ts";
import type { CommandResult } from "../consumer/lib/exec.ts";
import { EXCLUDED_PACKAGES, REGISTRY_PACKAGES } from "../release/lib/packages.ts";

import { observeBrowser } from "./lib/browser.ts";
import {
  EXPECTED_EVIDENCE,
  MARKERS,
  SERVER_MARKERS,
  SERVER_MESSAGE_A,
  SERVER_MESSAGE_B,
  SERVER_SOURCES,
} from "./lib/consumer-fixture.ts";
import { ANGULAR_COMPILER_FINGERPRINT, check, finish, repoRoot, section } from "./lib/harness.ts";
import { moduleGraph } from "./lib/module-graph.ts";
import {
  FORBIDDEN_TARBALL_PATH,
  NODE_BUILTINS,
  bareImports,
  evaluate,
  exportTargets,
  filesMentioning,
  findInstalledCopies,
  installedVersion,
  isSymlinkAnywhere,
  isUnder,
  isolatedEnv,
  openTracked,
  packageNameOf,
  readTarball,
  resolveFromConsumer,
  restoreDir,
  snapshotDiffers,
  snapshotDir,
  sleep,
  startDevServer,
  startNodeServer,
  startNodeServerCold,
  startWrangler,
  until,
} from "./lib/package-consumer.ts";
import type { RunningServer, Snapshot, Tarball } from "./lib/package-consumer.ts";
import {
  assessHydration,
  assessSsrDocument,
  describeAssessment,
  describeScan,
  keepIntegrityRecord,
  scanBuildOutput,
} from "./lib/ssr-integrity.ts";
import type { SsrExpectation, SsrReply } from "./lib/ssr-integrity.ts";

/**
 * `pnpm test:server-component-package-consumer`: can the PACKED
 * @strata-sc/server-components be installed and used by a real Analog
 * application completely outside the Strata workspace?
 * (docs/research/server-component-package-consumer.md)
 *
 *   package build → `pnpm pack` → .tgz (the only connection)
 *   → OS temp directory → `npm install` → real Analog app
 *   → tarball integrity, install integrity, declarations (TS 6 and 5.9),
 *     production Node build/SSR/hydration/navigation, server-only firewall,
 *     `vite` dev + one server-owned edit, Cloudflare build + workerd.
 *
 * It never edits the package manifest, never publishes, and never resolves
 * anything from the repository: the consumer's own `node_modules/.bin` run
 * every command.
 */

const TITLE = "server-component packed-package consumer qualification";
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureTemplate = join(repoRoot, "tests", "server-component-package-consumer", "fixture");
const angularWidgetsSource = join(
  repoRoot,
  "tests",
  "server-component-package-consumer",
  "angular-widgets",
);
const kitSource = join(repoRoot, "tests", "server-component-package-consumer", "kit");
const packageDir = join(repoRoot, "packages", "server-components");
const PACKAGE = "@strata-sc/server-components";
const WIDGETS_PACKAGE = "@strata-test/angular-widgets";
/** A plain ESM package with a browser-safe root and subpath and a server-only subpath and barrel. */
const KIT_PACKAGE = "@strata-test/kit";

const TS59_VERSION = "5.9.2";

const sanitize = (text: string): string => stripVTControlCharacters(text);
const all = (results: readonly boolean[]): boolean => results.every(Boolean);

/**
 * What a complete `/product` document is, by label (docs/research/server-component-ssr-integrity-v07.md):
 * an HTTP 200 alone never satisfies the qualification.
 */
const PRODUCT_PAGE: SsrExpectation = {
  content: {
    "server heading": "<h1>Product 42</h1>",
    "server message": `>${SERVER_MESSAGE_A}</p>`,
    "server-computed evidence": `data-evidence="${EXPECTED_EVIDENCE}"`,
    "public nested stock": "In stock: 12",
    "installed package island output": "STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT",
  },
  boundaries: [
    { selector: "add-to-cart", protocol: "2" },
    { selector: "acme-product-picker", protocol: "2" },
    { selector: "legacy-counter", protocol: "1" },
  ],
  forbidden: Object.fromEntries(SERVER_MARKERS.map((marker) => [marker, marker])),
};

/** Repeated independent builds per run: bounded for CI; the extended gate raises it. */
const REPEATED_BUILDS = Number(process.env["STRATA_INTEGRITY_BUILDS"] ?? "2");
/** Concurrent first requests against a cold server. */
const OVERLAPPING_FIRST_REQUESTS = 8;

/** Results of the production compilation contract, one per built output. */
const contract: boolean[] = [];
/** Results of the negative/positive controls and cold-start assessments. */
const integrity: boolean[] = [];

const verdict = {
  tarball: false,
  declarations59: false,
  declarations6: false,
  install: false,
  node: false,
  firewall: false,
  dev: false,
  cloudflare: false,
  confidentiality: false,
  compilation: false,
};

const timings: string[] = [];
const time = <T>(label: string, work: () => T): T => {
  const started = performance.now();

  try {
    return work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};
const timeAsync = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const started = performance.now();

  try {
    return await work();
  } finally {
    timings.push(`${label}: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
};

class Abort extends Error {}

function must(result: CommandResult, label: string): CommandResult {
  const ok = check(
    `${label} exits 0`,
    result.status === 0,
    sanitize(result.stderr || result.stdout).slice(-2_500),
  );

  if (!ok) throw new Abort(label);

  return result;
}

const servers: RunningServer[] = [];
const tmpRoot = mkdtempSync(join(tmpdir(), "strata-server-component-consumer-"));
const consumerDir = join(tmpRoot, "consumer");
const ts59Dir = join(tmpRoot, "consumer-ts59");
const emptyNpmrc = join(tmpRoot, "empty.npmrc");
const emptyGlobalNpmrc = join(tmpRoot, "empty-global.npmrc");
const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);

/** Everything under the consumer that is output or install, not authored source. */
const NOT_SOURCE = (path: string): boolean =>
  /^(node_modules|dist|\.nitro|\.output|\.angular|package-lock\.json)(\/|$)/.test(path) ||
  path.startsWith("src/generated/");

let templateBefore: Snapshot | undefined;
let pristine: Snapshot | undefined;

/** The consumer's own `vite` binary (never the repository's). */
const vite = (args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): CommandResult =>
  run(process.execPath, [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), ...args], {
    cwd: consumerDir,
    env: { ...env, ...extraEnv },
  });

function clean(): void {
  for (const dir of ["dist", "src/generated", ".nitro", ".angular"]) {
    rmSync(join(consumerDir, dir), { recursive: true, force: true });
  }
}

/** Final artifacts of one build: the SSR bundle, Nitro's server and Worker, and the browser graph. */
const OUTPUT_ROOTS = {
  classes: ["ssr", "analog/server", "analog/public/_worker.js", "client"],
  partials: ["ssr", "client"],
} as const;
const inDist = (roots: readonly string[]): string[] =>
  roots.map((root) => join(consumerDir, "dist", root));

/**
 * The compilation contract over what the build produced (after bundling and
 * Nitro): no module applies an Angular decorator, none still calls a partial
 * declaration, and the scan saw compiled definitions (it is not vacuous).
 */
function checkOutputContract(label: string): boolean {
  const scan = scanBuildOutput(
    { classes: inDist(OUTPUT_ROOTS.classes), partials: inDist(OUTPUT_ROOTS.partials) },
    consumerDir,
  );
  const ok = check(
    `${label}: every emitted Angular class is compiled and no partial declaration is unlinked`,
    scan.uncompiled.length === 0 && scan.unlinked.length === 0 && scan.definitions > 0,
    describeScan(scan),
  );

  if (!ok) keepIntegrityRecord(`output-${label}`, { class: "build-compilation", scan });

  contract.push(ok);

  return ok;
}

function build(label: string, extraEnv: NodeJS.ProcessEnv = {}): CommandResult {
  clean();

  const result = time(label, () => must(vite(["build"], extraEnv), label));

  checkOutputContract(label);

  return result;
}

/**
 * With `STRATA_DIAGNOSTICS_DIR` set (CI sets it) and a failed qualification, keeps the consumer's
 * last SSR bundle (JavaScript only, no maps, no dependencies, bounded) next to the server logs:
 * the intermittent failure this gate exists for left no built output behind the first time.
 */
function retainFailedOutput(): void {
  const directory = process.env["STRATA_DIAGNOSTICS_DIR"];

  if (!directory || Object.values(verdict).every(Boolean)) return;

  try {
    const target = join(directory, "consumer-ssr-output");

    for (const root of ["ssr", "analog/server"]) {
      const from = dist(root);

      if (!existsSync(from)) continue;

      for (const file of listFiles(from)) {
        if (!/\.m?js$/.test(file) || file.startsWith("node_modules/")) continue;

        const source = join(from, file);

        if (lstatSync(source).size > 2_000_000) continue;

        mkdirSync(dirname(join(target, root, file)), { recursive: true });
        cpSync(source, join(target, root, file));
      }
    }
  } catch {
    // Diagnostics must never change the result of a run.
  }
}

/** One SSR answer, assessed as a whole (class-labelled), never by status alone. */
function assessProduct(label: string, reply: SsrReply, serverLog: string): boolean {
  const assessment = assessSsrDocument(reply, serverLog, PRODUCT_PAGE);

  if (!assessment.ok) {
    keepIntegrityRecord(label, {
      label,
      findings: assessment.findings,
      summary: assessment.summary,
    });
  }

  return check(
    `${label}: complete SSR document, clean server log`,
    assessment.ok,
    describeAssessment(assessment),
  );
}

/** `count` GETs issued behind one barrier: all are constructed before any is sent. */
async function overlapped(url: string, count: number): Promise<SsrReply[]> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const pending = Array.from({ length: count }, async () => {
    await gate;

    return httpGet(url);
  });

  open();

  return Promise.all(pending);
}

const dist = (...parts: string[]): string => join(consumerDir, "dist", ...parts);
const graphFiles = (dirs: readonly string[], skip: (file: string) => boolean = () => false) =>
  dirs
    .flatMap((dir) =>
      existsSync(dist(dir)) ? listFiles(dist(dir)).map((file) => `${dir}/${file}`) : [],
    )
    .filter((file) => !skip(file));
const filesWith = (files: readonly string[], needle: string): string[] =>
  files.filter((file) => readFileSync(dist(file), "utf8").includes(needle));

/** Source paths named by the `.map` files among `files` (hidden maps are not referenced). */
function mapSources(files: readonly string[]): string[] {
  return files
    .filter((file) => file.endsWith(".map"))
    .flatMap(
      (file) =>
        (JSON.parse(readFileSync(dist(file), "utf8")) as { sources?: string[] }).sources ?? [],
    );
}

try {
  writeFileSync(emptyNpmrc, "");
  writeFileSync(emptyGlobalNpmrc, "");
  templateBefore = snapshotDir(fixtureTemplate, () => false);

  // ------------------------------------------------------------------------
  section("Release invariants: registry-eligible, version owned by Changesets");

  const sourceManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
    publishConfig?: { access?: string; tag?: string };
  };

  // The qualification packs the current package whatever its version: 0.0.0
  // before the Version Packages PR is expected and is not a failure here
  // (the release inspector, not this gate, requires a released version).
  check(
    `package is ${sourceManifest.name}@${sourceManifest.version}, public and registry-eligible`,
    sourceManifest.name === PACKAGE &&
      sourceManifest.private === undefined &&
      sourceManifest.publishConfig?.access === "public" &&
      sourceManifest.publishConfig.tag === undefined,
  );
  check(
    "selected for registry release; @strata-sc/h3 stays excluded",
    REGISTRY_PACKAGES.some(({ name }) => name === PACKAGE) &&
      !EXCLUDED_PACKAGES.includes(PACKAGE) &&
      EXCLUDED_PACKAGES.includes("@strata-sc/h3"),
  );

  // ------------------------------------------------------------------------
  section("Build and pack the real package");

  rmSync(join(packageDir, "dist"), { recursive: true, force: true });
  time("package build", () =>
    must(
      run("pnpm", ["--filter", PACKAGE, "run", "build"], { cwd: repoRoot }),
      "pnpm --filter @strata-sc/server-components build",
    ),
  );

  const tarballDir = join(tmpRoot, "tarballs");
  mkdirSync(tarballDir, { recursive: true });
  must(run("pnpm", ["pack", "--pack-destination", tarballDir], { cwd: packageDir }), "pnpm pack");

  const tarballPath = readdirSync(tarballDir)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(tarballDir, name))[0]!;
  const tarball: Tarball = readTarball(tarballPath, join(tmpRoot, "extracted"));

  console.log(`tarball: ${tarballPath.split("/").pop()}`);
  console.log(
    `packed size: ${tarball.sizeBytes} bytes (${(tarball.sizeBytes / 1024).toFixed(1)} kB)`,
  );
  console.log(`files (${tarball.files.length}):\n  ${tarball.files.join("\n  ")}`);

  // ------------------------------------------------------------------------
  section("Tarball integrity");

  const has = (file: string): boolean => tarball.files.includes(file);
  const tarballOk: boolean[] = [];

  tarballOk.push(
    check(
      "packed manifest is the unmodified source manifest (public, same version)",
      tarball.manifest.private === undefined && tarball.manifest.version === sourceManifest.version,
    ),
    check(
      "required files present",
      all(
        [
          "package.json",
          "README.md",
          "LICENSE",
          "dist/fesm2022/index.js",
          "dist/fesm2022/index.d.ts",
          "dist/vite.js",
          "dist/vite/index.d.ts",
          "dist/server-only.js",
          "dist/server-only/index.d.ts",
        ].map(has),
      ),
      ["package.json", "README.md", "LICENSE", "dist/vite.js", "dist/server-only.js"]
        .filter((f) => !has(f))
        .join(", "),
    ),
  );

  const license = readFileSync(join(repoRoot, "LICENSE"), "utf8");

  tarballOk.push(
    check(
      "LICENSE is the repository's MIT license, byte for byte",
      has("LICENSE") &&
        readFileSync(join(tarball.extractedDir, "LICENSE"), "utf8") === license &&
        /MIT License/.test(license),
    ),
  );

  const targets = exportTargets(tarball.manifest);
  const dangling = targets.filter(({ target }) => !has(target.replace(/^\.\//, "")));

  tarballOk.push(
    check(
      `every export target exists in the tarball (${targets.map((t) => `${t.subpath}[${t.condition}]`).join(", ")})`,
      targets.length > 0 &&
        dangling.length === 0 &&
        Object.keys(tarball.manifest.exports ?? {}).every(
          (subpath) =>
            subpath === "./package.json" ||
            ["types", "default"].every((condition) =>
              targets.some((t) => t.subpath === subpath && t.condition === condition),
            ),
        ),
      dangling.map((d) => d.target).join(", "),
    ),
  );

  const leaked = tarball.files.filter((file) => FORBIDDEN_TARBALL_PATH.test(file));
  const unexpected = tarball.files.filter(
    (file) => !file.startsWith("dist/") && !["package.json", "README.md", "LICENSE"].includes(file),
  );

  tarballOk.push(
    check(
      "no source, test, config, tools, apps, .git or node_modules in the tarball",
      leaked.length === 0,
      leaked.join(", "),
    ),
    check(
      "nothing outside dist/ except package.json, README.md and LICENSE",
      unexpected.length === 0,
      unexpected.join(", "),
    ),
  );

  const declared = {
    dependencies: tarball.manifest.dependencies ?? {},
    peerDependencies: tarball.manifest.peerDependencies ?? {},
    optionalDependencies: tarball.manifest.optionalDependencies ?? {},
  };
  const rangeProblems = Object.entries(declared).flatMap(([field, deps]) =>
    Object.entries(deps)
      .filter(([, range]) => /^(workspace|link|portal|file):/.test(range))
      .map(([name, range]) => `${field}.${name}=${range}`),
  );

  tarballOk.push(
    check(
      "no workspace:/link:/portal:/file: ranges in dependencies, peerDependencies, optionalDependencies",
      rangeProblems.length === 0,
      rangeProblems.join(", "),
    ),
  );

  const imports = bareImports(tarball.extractedDir, tarball.files);
  const classified = new Map<string, { kind: string; files: Set<string> }>();

  for (const { file, specifier } of imports) {
    const name = packageNameOf(specifier.replace(/^node:/, ""));
    const kind =
      specifier.startsWith("node:") || NODE_BUILTINS.has(name)
        ? "node built-in"
        : name === PACKAGE
          ? "self (text emitted into consumer sources)"
          : name in declared.dependencies
            ? "declared dependency"
            : name in declared.peerDependencies
              ? "declared peerDependency"
              : "UNDECLARED";
    const entry = classified.get(specifier) ?? { kind, files: new Set<string>() };

    entry.files.add(file);
    classified.set(specifier, entry);
  }

  console.log("emitted bare-import closure (dist/**/*.js):");
  for (const [specifier, { kind, files }] of [...classified].sort()) {
    console.log(`  ${specifier.padEnd(48)} ${kind.padEnd(14)} ${[...files].join(", ")}`);
  }

  const undeclared = [...classified]
    .filter(([, { kind }]) => kind === "UNDECLARED")
    .map(([specifier]) => specifier);

  tarballOk.push(
    check(
      "every emitted bare import is a Node built-in, a declared dependency or a declared peer",
      undeclared.length === 0,
      undeclared.join(", "),
    ),
    check(
      "the emitted code imports no tslib (nothing to declare)",
      ![...classified.keys()].some((s) => s === "tslib" || s.startsWith("tslib/")),
    ),
  );

  // Peers: each declared peer is used by the emitted JS or its declarations.
  const textFiles = tarball.files.filter((f) => /\.(js|d\.ts)$/.test(f));
  const peerUse = Object.keys(declared.peerDependencies).map((peer) => ({
    peer,
    used: textFiles.some((file) =>
      new RegExp(`from ["']${peer.replace("/", "\\/")}(/[^"']*)?["']`).test(
        readFileSync(join(tarball.extractedDir, file), "utf8"),
      ),
    ),
  }));

  console.log(
    `peer usage: ${peerUse.map(({ peer, used }) => `${peer}=${used ? "used" : "UNUSED"}`).join(", ")}`,
  );
  const declaredPeerNames = new Set(Object.keys(declared.peerDependencies));
  tarballOk.push(
    check(
      "every declared peer is imported by the emitted code or declarations (no padding)",
      peerUse.every(({ used }) => used),
      peerUse
        .filter((p) => !p.used)
        .map((p) => p.peer)
        .join(", "),
    ),
    check(
      "no undeclared peer-like import: only declared peers, typescript, vite, node:*",
      [...classified.keys()].every(
        (s) =>
          s.startsWith("node:") ||
          s === "typescript" ||
          s === "vite" ||
          declaredPeerNames.has(packageNameOf(s)) ||
          classified.get(s)!.kind.startsWith("self"),
      ),
    ),
  );

  const absolute = filesMentioning(tarball.extractedDir, tarball.files, [
    repoRoot,
    homedir(),
    tmpRoot,
    "/Users/",
    "/home/runner",
  ]);

  tarballOk.push(
    check(
      "no absolute repository, home or temp path in any textual tarball file (js, d.ts, maps)",
      absolute.length === 0,
      absolute.join(", "),
    ),
  );

  const fesm = tarball.files.filter((f) => f.startsWith("dist/fesm2022/") && f.endsWith(".js"));
  const partial = fesm.filter((f) =>
    readFileSync(join(tarball.extractedDir, f), "utf8").includes("ɵɵngDeclare"),
  );

  console.log(`Angular partial declarations (ɵɵngDeclare*) in: ${partial.join(", ") || "(none)"}`);
  tarballOk.push(
    check(
      "the runtime is Angular partial-compiled (ɵɵngDeclare*), not JIT or fully compiled",
      partial.length > 0,
    ),
  );

  verdict.tarball = all(tarballOk);

  // ------------------------------------------------------------------------
  section("Build and pack an independently compiled Angular partial library");

  const widgetsDir = join(tmpRoot, "angular-widgets");
  const widgetsTarballs = join(tmpRoot, "widgets-tarballs");
  cpSync(angularWidgetsSource, widgetsDir, { recursive: true });
  mkdirSync(widgetsTarballs, { recursive: true });
  symlinkSync(join(packageDir, "node_modules"), join(widgetsDir, "node_modules"), "dir");
  must(
    run("pnpm", ["--filter", PACKAGE, "exec", "ngc", "-p", join(widgetsDir, "tsconfig.json")], {
      cwd: repoRoot,
    }),
    "ngc partial-compiles @strata-test/angular-widgets",
  );
  must(
    run(
      "npm",
      [
        "pack",
        "--pack-destination",
        widgetsTarballs,
        "--cache",
        join(tmpRoot, "npm-cache"),
        "--logs-dir",
        join(tmpRoot, "npm-logs"),
      ],
      { cwd: widgetsDir },
    ),
    "npm pack @strata-test/angular-widgets",
  );
  const widgetsTarball = readdirSync(widgetsTarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(widgetsTarballs, name))[0]!;
  const widgetsArchive = readTarball(widgetsTarball, join(tmpRoot, "widgets-extracted"));
  const widgetsPartial = widgetsArchive.files.some(
    (file) =>
      file.startsWith("dist/") &&
      readFileSync(join(widgetsArchive.extractedDir, file), "utf8").includes(
        "ɵɵngDeclareComponent",
      ),
  );
  check(
    "the test library is private and packed independently",
    widgetsArchive.manifest.name === WIDGETS_PACKAGE && widgetsArchive.manifest.private === true,
  );
  check("the package tarball contains Angular partial declarations", widgetsPartial);

  // ------------------------------------------------------------------------
  const kitDir = join(tmpRoot, "kit");
  const kitTarballs = join(tmpRoot, "kit-tarballs");

  cpSync(kitSource, kitDir, { recursive: true });
  mkdirSync(kitTarballs, { recursive: true });
  must(
    run(
      "npm",
      [
        "pack",
        "--pack-destination",
        kitTarballs,
        "--cache",
        join(tmpRoot, "npm-cache"),
        "--logs-dir",
        join(tmpRoot, "npm-logs"),
      ],
      { cwd: kitDir },
    ),
    "npm pack @strata-test/kit",
  );

  const kitTarball = readdirSync(kitTarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(kitTarballs, name))[0]!;

  // ------------------------------------------------------------------------
  section("External install (npm, outside the workspace)");

  check(
    "the consumer lives outside the repository",
    !consumerDir.startsWith(repoRoot) && !realpathSync(tmpRoot).startsWith(realpathSync(repoRoot)),
  );
  cpSync(fixtureTemplate, consumerDir, { recursive: true });
  pristine = snapshotDir(consumerDir, NOT_SOURCE);

  const consumerManifestPath = join(consumerDir, "package.json");
  const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  check(
    "the fixture template names no workspace, link or relative dependency",
    !/workspace:|link:|portal:|\.\.\//.test(JSON.stringify(consumerManifest)),
  );
  check(
    "the fixture is not part of pnpm-workspace.yaml",
    !/tests\//.test(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8")),
  );

  consumerManifest.dependencies[PACKAGE] = `file:${tarballPath}`;
  consumerManifest.dependencies[WIDGETS_PACKAGE] = `file:${widgetsTarball}`;
  consumerManifest.dependencies[KIT_PACKAGE] = `file:${kitTarball}`;
  writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);
  pristine = snapshotDir(consumerDir, NOT_SOURCE);

  const installArgs = [
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--cache",
    join(tmpRoot, "npm-cache"),
    "--logs-dir",
    join(tmpRoot, "npm-logs"),
    "--fetch-retries=0",
    "--fetch-timeout=30000",
  ];

  console.log(
    `install command: npm ${installArgs.join(" ")}  (cwd ${consumerDir}; empty user config; npm_*/pnpm_*/NODE_PATH/NODE_OPTIONS removed)`,
  );
  time("npm install (consumer)", () =>
    must(run("npm", installArgs, { cwd: consumerDir, env }), "npm install"),
  );

  const installed = join(consumerDir, "node_modules", PACKAGE);
  const installOk: boolean[] = [];

  installOk.push(
    check("installed package directory exists", existsSync(join(installed, "package.json"))),
    check(
      "it is a real directory, not a symlink, junction or portal",
      !isSymlinkAnywhere(installed) && lstatSync(installed).isDirectory(),
    ),
  );

  const installedFiles = listFiles(installed).filter((f) => !f.startsWith("node_modules/"));

  installOk.push(
    check(
      "it holds exactly the tarball's files (no src/, nothing extra)",
      installedFiles.join("\n") === tarball.files.join("\n") && !existsSync(join(installed, "src")),
    ),
    check(
      "exactly one copy of the package in the installed tree",
      findInstalledCopies(consumerDir, PACKAGE).length === 1,
      findInstalledCopies(consumerDir, PACKAGE).join(", "),
    ),
  );

  const strataInstalled = readdirSync(join(consumerDir, "node_modules", "@strata-sc"));

  installOk.push(
    check(
      "no other @strata-sc package is installed (core, analog, h3 not required)",
      strataInstalled.join(",") === "server-components",
      strataInstalled.join(","),
    ),
  );

  const resolved = resolveFromConsumer(
    consumerDir,
    [PACKAGE, `${PACKAGE}/vite`, `${PACKAGE}/server-only`, WIDGETS_PACKAGE],
    env,
  );

  for (const [specifier, url] of Object.entries(resolved)) {
    console.log(`resolve ${specifier} → ${url}`);
  }

  installOk.push(
    check(
      "`.`, `/vite` and `/server-only` resolve under consumer/node_modules/",
      Object.entries(resolved).every(([specifier, url]) =>
        specifier === WIDGETS_PACKAGE
          ? isUnder(url, join(consumerDir, "node_modules")) &&
            url.includes("/node_modules/@strata-test/angular-widgets/dist/")
          : isUnder(url, join(consumerDir, "node_modules")) &&
            url.includes("/node_modules/@strata-sc/server-components/dist/"),
      ),
    ),
    check(
      "the Strata and library packages resolve from installed package exports, not workspace source",
      Object.values(resolved).every(
        (url) => !realpathSync(new URL(url)).startsWith(realpathSync(repoRoot) + "/"),
      ),
      Object.values(resolved).join(", "),
    ),
  );

  // The framework tuple the installed package graph actually uses.
  const installedLine = (names: readonly string[]): string =>
    names.map((name) => `${name}@${installedVersion(consumerDir, name)}`).join(", ");

  console.log(`node ${process.version}`);
  console.log(
    `tuple: ${installedLine(["@angular/core", "@angular/common", "@angular/compiler", "@angular/router", "@angular/platform-browser", "@angular/platform-server", "@angular/compiler-cli", "@angular/build"])}`,
  );
  console.log(
    `       ${installedLine(["@analogjs/platform", "@analogjs/router", "@analogjs/vite-plugin-angular", "@analogjs/vite-plugin-nitro", "nitropack", "vite", "typescript", "rxjs", "tslib", "wrangler"])}`,
  );
  console.log(
    `       playwright@${(JSON.parse(readFileSync(join(repoRoot, "node_modules", "playwright", "package.json"), "utf8")) as { version: string }).version} (the runner's browser driver, not a consumer dependency)`,
  );

  // A single Angular universe, resolved from the installed package itself.
  const fromPackage = resolveFromConsumer(
    installed,
    ["@angular/core", "@angular/compiler", "vite", "typescript", WIDGETS_PACKAGE],
    env,
  );

  for (const [specifier, url] of Object.entries(fromPackage))
    console.log(`from the package: ${specifier} → ${url}`);

  const copiesOf = (name: string): string[] => findInstalledCopies(consumerDir, name);

  installOk.push(
    check(
      "the installed package resolves @angular/core, @angular/compiler, vite and typescript from consumer/node_modules",
      Object.values(fromPackage).every(
        (url) => isUnder(url, join(consumerDir, "node_modules")) && !url.includes(repoRoot),
      ),
    ),
    check(
      "one installed copy each of @angular/core and @angular/compiler",
      copiesOf("@angular/core").length === 1 && copiesOf("@angular/compiler").length === 1,
      `${copiesOf("@angular/core").join(",")} | ${copiesOf("@angular/compiler").join(",")}`,
    ),
    check(
      "one installed copy of vite (plus the nested ones of @angular/build and the pinned vitest) and of typescript",
      copiesOf("vite").filter(
        (copy) =>
          !copy.startsWith("node_modules/@angular/build/") &&
          !copy.startsWith("node_modules/vitest/"),
      ).length === 1 && copiesOf("typescript").length === 1,
      `${copiesOf("vite").join(",")} | ${copiesOf("typescript").join(",")}`,
    ),
  );

  const ls = run("npm", ["ls", "--all", "--json"], { cwd: consumerDir, env });
  const lsJson = JSON.parse(ls.stdout || "{}") as { problems?: string[] };
  const problems = lsJson.problems ?? [];
  // Each problem reads "<kind>: <name>@<version> <absolute path>": judge the name, not the temp path.
  const problemName = (p: string): string => p.replace(/\s\/\S+$/, "");
  const strataProblems = problems.filter((p) => /@strata-sc\//.test(problemName(p)));

  console.log(
    `npm ls --all: exit ${ls.status}; ${problems.length} problem(s)${problems.length ? `:\n  ${problems.join("\n  ")}` : ""}`,
  );
  installOk.push(
    check(
      "npm ls --all reports no UNMET, invalid peer or extraneous Strata package",
      strataProblems.length === 0,
      strataProblems.join("; "),
    ),
    check(
      "npm ls --all: no problem touches Angular, Analog, Vite, TypeScript, Nitro or Wrangler (remaining ones are npm optional-dependency noise)",
      problems.every(
        (p) =>
          !/UNMET|@angular\/|@analogjs\/|\/vite|typescript|nitro|wrangler|rxjs|tslib/i.test(
            problemName(p),
          ),
      ),
    ),
  );

  verdict.install = all(installOk);

  // ------------------------------------------------------------------------
  section("Declaration portability (TypeScript 6 and 5.9)");

  const tscDeclarations = (dir: string, label: string): { ok: boolean; version: string } => {
    const tsc = join(dir, "node_modules", "typescript", "bin", "tsc");
    const version = installedVersion(dir, "typescript");
    const result = run(
      process.execPath,
      [tsc, "-p", "tsconfig.check.json", "--listFiles", "--noEmit"],
      { cwd: dir, env },
    );
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const listed = lines.filter((line) => line.startsWith("/"));
    const diagnostics = lines.filter((line) => /error TS\d+/.test(line));
    const strata = listed.filter((file) => file.includes("/@strata-sc/server-components/"));
    const fromRepo = listed.filter((file) =>
      realpathSync(file).startsWith(realpathSync(repoRoot) + "/"),
    );
    const fromPackageSrc = listed.filter((file) => /server-components\/src\//.test(file));

    console.log(
      `${label}: typescript@${version}, ${listed.length} files, ${strata.length} from the installed package, ${diagnostics.length} diagnostic(s)`,
    );

    return {
      version,
      ok: all([
        check(
          `${label}: skipLibCheck:false, strict, moduleResolution Bundler — 0 diagnostics`,
          result.status === 0 && diagnostics.length === 0,
          diagnostics.slice(0, 8).join("\n"),
        ),
        check(
          `${label}: all Strata declarations come from node_modules/@strata-sc/server-components/dist`,
          ["fesm2022/index.d.ts", "vite/index.d.ts", "server-only/index.d.ts"].every((entry) =>
            strata.some((file) => file.endsWith(`/dist/${entry}`)),
          ) &&
            strata.every((file) =>
              file.includes("/node_modules/@strata-sc/server-components/dist/"),
            ),
        ),
        check(
          `${label}: no file resolves from the repository or from package src/`,
          fromRepo.length === 0 && fromPackageSrc.length === 0,
          [...fromRepo, ...fromPackageSrc].join(", "),
        ),
      ]),
    };
  };

  const ts6 = tscDeclarations(consumerDir, "TypeScript 6");

  check("TypeScript 6.0.3 is the declaration consumer", ts6.version === "6.0.3", ts6.version);
  verdict.declarations6 = ts6.ok;

  // TypeScript 5.9.2: a second, minimal isolated consumer (no Analog app needed).
  mkdirSync(join(ts59Dir, "src", "check"), { recursive: true });
  cpSync(join(consumerDir, "tsconfig.check.json"), join(ts59Dir, "tsconfig.check.json"));
  cpSync(
    join(consumerDir, "src", "check", "declarations.ts"),
    join(ts59Dir, "src", "check", "declarations.ts"),
  );
  writeFileSync(
    join(ts59Dir, "package.json"),
    `${JSON.stringify(
      {
        name: "strata-server-component-declarations-ts59",
        private: true,
        type: "module",
        dependencies: {
          [PACKAGE]: `file:${tarballPath}`,
          "@angular/core": consumerManifest.dependencies["@angular/core"],
          "@angular/compiler": consumerManifest.dependencies["@angular/compiler"],
          rxjs: consumerManifest.dependencies["rxjs"],
          vite: consumerManifest.devDependencies["vite"],
          "@types/node": consumerManifest.devDependencies["@types/node"],
          typescript: TS59_VERSION,
        },
      },
      null,
      2,
    )}\n`,
  );
  time("npm install (TypeScript 5.9 consumer)", () =>
    must(run("npm", installArgs, { cwd: ts59Dir, env }), "npm install (TypeScript 5.9 consumer)"),
  );

  const ts59 = tscDeclarations(ts59Dir, "TypeScript 5.9");

  check(
    `TypeScript ${TS59_VERSION} is the declaration consumer`,
    ts59.version === TS59_VERSION,
    ts59.version,
  );
  verdict.declarations59 = ts59.ok && ts59.version === TS59_VERSION;

  // ------------------------------------------------------------------------
  section("External production build (Node)");

  const buildLog = sanitize(build("consumer `vite build`").stdout);

  void buildLog;

  const generated = join(
    consumerDir,
    "src",
    "generated",
    "server-components",
    "product",
    "product-details.server-component.ts",
  );

  check(
    "surrogates are generated inside the EXTERNAL app (src/generated/server-components)",
    existsSync(generated),
  );

  const surrogate = readFileSync(generated, "utf8");

  check(
    "the surrogate imports the runtime as `@strata-sc/server-components`, never a path",
    /from "@strata-sc\/server-components";/.test(surrogate) &&
      !surrogate.includes(repoRoot) &&
      !surrogate.includes(tmpRoot) &&
      !/packages\/server-components/.test(surrogate),
  );

  const browserDirs = ["client", "analog/public"] as const;
  const browser = graphFiles(browserDirs);
  const server = graphFiles(["analog/server", "ssr"]);
  const browserJs = browser.filter((f) => f.endsWith(".js"));
  const serverJs = server.filter((f) => /\.(m?js)$/.test(f));

  const nodeOk: boolean[] = [];

  for (const marker of SERVER_MARKERS) {
    nodeOk.push(
      check(
        `${marker}: absent from every browser file`,
        filesWith(browser, marker).length === 0,
        filesWith(browser, marker).join(", "),
      ),
    );
  }
  nodeOk.push(
    check(
      `${MARKERS.client}: present in the browser graph`,
      filesWith(browserJs, MARKERS.client).length > 0,
    ),
    check(
      "browser output names none of the consumer's server-only code (ProductRepository, server helper, the implementation constant)",
      ["ProductRepository", "readServerHelper", "IMPLEMENTATION_MARKER"].every(
        (name) => filesWith(browserJs, name).length === 0,
      ),
    ),
  );
  for (const marker of SERVER_MARKERS) {
    nodeOk.push(
      check(
        `${marker}: present in the Node server output (positive control)`,
        filesWith(serverJs, marker).length > 0,
      ),
    );
  }

  const sources = mapSources(browser);
  const serverSourcesInBrowser = sources.filter((source) =>
    // The generated surrogate shares the Server Component's file name; it is the
    // browser's stand-in, so it is expected in the maps.
    SERVER_SOURCES.some((file) => source.endsWith(file) && !source.includes("/generated/")),
  );

  console.log(
    `browser source maps: ${browser.filter((f) => f.endsWith(".map")).length} files, ${sources.length} sources`,
  );
  nodeOk.push(
    check("browser source maps exist (the graph check is not vacuous)", sources.length > 20),
    check(
      "browser source maps name none of the consumer's server files",
      serverSourcesInBrowser.length === 0,
      serverSourcesInBrowser.join(", "),
    ),
    check(
      "browser source maps include the client island and the generated surrogate",
      sources.some((s) => s.endsWith("add-to-cart.component.ts")) &&
        sources.some((s) =>
          s.includes("node_modules/@strata-test/angular-widgets/dist/fesm2022/index.js"),
        ) &&
        sources.some((s) =>
          s.includes("generated/server-components/product/product-details.server-component.ts"),
        ),
    ),
    check(
      "the surrogate's runtime import resolves to consumer/node_modules/@strata-sc/server-components (browser source map)",
      sources.some((s) => s.includes("node_modules/@strata-sc/server-components/dist/fesm2022/")) &&
        !sources.some((s) => /packages\/server-components|\/Strata\//.test(s)),
    ),
  );
  nodeOk.push(
    check(
      "the external Angular library is present in browser JavaScript",
      filesWith(browserJs, "STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT").length > 0,
    ),
  );

  const toolingMarkers = [
    ANGULAR_COMPILER_FINGERPRINT,
    "node:fs",
    "node:path",
    "strata:server-components",
    "createSourceFile",
    "Server Component graph could not be refreshed",
  ];
  const tooling = toolingMarkers.filter((marker) => filesWith(browserJs, marker).length > 0);

  nodeOk.push(
    check(
      "no package build tooling in the browser (no @angular/compiler, TypeScript API, Vite plugin source, node:fs/node:path)",
      tooling.length === 0,
      tooling.join(", "),
    ),
  );

  const ssrSources = mapSources(server);

  nodeOk.push(
    check(
      "server output includes the consumer's server sources (source-map positive control)",
      SERVER_SOURCES.every((file) => ssrSources.some((s) => s.endsWith(file))),
    ),
  );

  // Production server.
  const node = await timeAsync("start production server", () => startNodeServer(consumerDir, env));

  servers.push(node);
  section("Production server: SSR, v1 + v2, hydration, interaction");

  const response = await httpGet(`${node.baseUrl}/product`);
  const html = response.body;

  nodeOk.push(
    check(
      "GET /product: 200 text/html",
      response.status === 200 && !!response.contentType?.includes("text/html"),
    ),
    check(
      "SSR HTML has the server-rendered content",
      html.includes("<h1>Product 42</h1>") && html.includes(`>${SERVER_MESSAGE_A}</p>`),
    ),
    check(
      "SSR HTML carries the server-computed data (data-evidence)",
      html.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
      html.match(/data-evidence="[^"]*"/)?.[0] ?? "",
    ),
    check(
      'SSR HTML has the structured boundary with data-strata-protocol="2" and an ngh annotation',
      /<add-to-cart data-strata-client="add-to-cart" data-strata-protocol="2" data-strata-props="\{&quot;product&quot;:\{&quot;id&quot;:&quot;42&quot;,&quot;name&quot;:&quot;Product 42&quot;,&quot;variants&quot;:\[/.test(
        html,
      ),
      html.match(/<add-to-cart[^>]*>/)?.[0] ?? "no boundary",
    ),
    check(
      "SSR renders the installed package component as protocol v2 with its public input alias",
      /<acme-product-picker[^>]*data-strata-client="acme-product-picker"[^>]*data-strata-protocol="2"[^>]*data-strata-props="\{&quot;productView&quot;:\{&quot;id&quot;:&quot;42&quot;/.test(
        html,
      ) && html.includes("STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT"),
      html.match(/<acme-product-picker[^>]*>/)?.[0] ?? "no external package boundary",
    ),
    check(
      "SSR HTML keeps the primitive sibling on protocol v1",
      /<legacy-counter data-strata-client="legacy-counter" data-strata-protocol="1" data-strata-props="\{&quot;start&quot;:0\}" ngh="\d+">/.test(
        html,
      ),
    ),
    check(
      "SSR HTML exposes no server implementation marker as public data",
      SERVER_MARKERS.every((marker) => !html.includes(marker)),
    ),
    check(
      "the server log shows no JIT compilation fallback or error",
      !/JIT compilation|needs to be compiled using the JIT|ERROR/.test(sanitize(node.output())),
      sanitize(node.output()).slice(0, 600),
    ),
  );

  nodeOk.push(assessProduct("Node SSR", response, sanitize(node.output())));

  const observation = await observeBrowser(`${node.baseUrl}/product`);
  check(
    "packed runtime emits one frozen, safe committed-host event",
    observation.hydrationObservations.length === 1 &&
      observation.hydrationObservationsFrozen &&
      observation.hydrationObservations[0]?.hostSelector === "product-details" &&
      observation.hydrationObservations[0]?.outcome === "committed" &&
      observation.hydrationObservations[0]?.discoveredBoundaries ===
        observation.hydrationObservations[0]?.committedBoundaries &&
      Number.isFinite(observation.hydrationObservations[0]?.elapsedMs) &&
      !JSON.stringify(observation.hydrationObservations).includes("STRATA_OBSERVER_PRIVATE_CANARY"),
    JSON.stringify(observation.hydrationObservations),
  );
  const isolatedObserver = await observeBrowser(`${node.baseUrl}/product?observer=reject`);
  check(
    "packed runtime consumes a rejected observer Promise without changing hydration or ErrorHandler",
    isolatedObserver.hydrationObservations.length === 1 &&
      isolatedObserver.hydrationObservationsFrozen &&
      isolatedObserver.hydrationObservations[0]?.outcome === "committed" &&
      isolatedObserver.countAfterClick === "Count: 1" &&
      isolatedObserver.errors.length === 0,
    JSON.stringify({
      events: isolatedObserver.hydrationObservations,
      count: isolatedObserver.countAfterClick,
      errors: isolatedObserver.errors,
    }),
  );

  nodeOk.push(
    check(
      "before any script: server HTML is visible with Count: 0",
      observation.beforeScripts.productVisible && observation.beforeScripts.count === "Count: 0",
    ),
    check("the client island hydrates", observation.hydratedWithinTimeout),
    check(
      "SSR DOM nodes are reused (article, heading, button, count text keep identity)",
      Object.values(observation.sameNodes).every(Boolean),
      JSON.stringify(observation.sameNodes),
    ),
    check(
      "the public nested product view is visible before scripts",
      html.includes("Black") &&
        html.includes("White") &&
        html.includes("In stock: 12") &&
        observation.beforeScripts.stock === "In stock: 12",
    ),
    check(
      "the installed package component receives its aliased nested input and reuses SSR DOM",
      observation.beforeScripts.packageStock === "Stock: 12" &&
        observation.sameNodes.packageButton === true &&
        observation.sameNodes.packageStockText === true &&
        observation.sameNodes.packageAlternateButton === true &&
        observation.beforeScripts.packageAlternateStock === "Stock: 112",
    ),
    check(
      "one keyboard action updates package state and emits one event",
      observation.packageStockAfterKeyboard === "Stock: 5" &&
        observation.packageEventsAfterKeyboard === "1" &&
        observation.packageAlternateStockAfterKeyboard === "Stock: 112" &&
        observation.packageAlternateEventsAfterKeyboard === "0",
      `primary ${observation.packageStockAfterKeyboard}; ${observation.packageEventsAfterKeyboard} event(s); sibling ${observation.packageAlternateStockAfterKeyboard}, ${observation.packageAlternateEventsAfterKeyboard} event(s)`,
    ),
    check(
      "keyboard selection updates variant stock and preserves the SSR button",
      observation.stockAfterKeyboard === "In stock: 5" &&
        observation.selectedVariantAfterKeyboard === "true" &&
        observation.variantButtonSurvivedKeyboard,
      `${observation.stockAfterKeyboard}; selected=${observation.selectedVariantAfterKeyboard}`,
    ),
    check(
      "no leftover ngh annotations, both v1 and v2 islands hydrate",
      observation.remainingHydrationAnnotations === 0 && observation.hydratedIslands === 4,
      `${observation.remainingHydrationAnnotations} ngh, ${observation.hydratedIslands} islands`,
    ),
    check(
      "the installed package component hydrates over SSR DOM and receives its aliased nested input",
      observation.sameNodes.packageButton === true &&
        observation.sameNodes.packageStockText === true &&
        observation.beforeScripts.packageStock === "Stock: 12",
    ),
    check(
      "one keyboard interaction changes one package-local state and fires one event",
      observation.packageStockAfterKeyboard === "Stock: 5" &&
        observation.packageEventsAfterKeyboard === "1",
      `${observation.packageStockAfterKeyboard}; ${observation.packageEventsAfterKeyboard} event(s)`,
    ),
    check(
      "one click: Count: 0 → Count: 1, the SSR button survived",
      observation.countAfterHydration === "Count: 0" &&
        observation.countAfterClick === "Count: 1" &&
        observation.buttonSurvivedClick,
      `${observation.countAfterHydration} → ${observation.countAfterClick}`,
    ),
    check(
      "no console error/warning (no NG hydration, no JIT, no unlinked partial declaration)",
      observation.errors.length === 0,
      observation.errors.join(" | "),
    ),
    check(
      "no loaded script carries a server marker; the client marker was loaded",
      observation.scripts.every((s) => SERVER_MARKERS.every((m) => !s.body.includes(m))) &&
        observation.scripts.some((s) => s.body.includes(MARKERS.client)),
    ),
    check(
      "the browser never loaded a Strata tooling fingerprint",
      observation.scripts.every(
        (s) =>
          !s.body.includes(ANGULAR_COMPILER_FINGERPRINT) &&
          !s.body.includes("strata:server-components"),
      ),
    ),
  );

  const hydrationFindings = assessHydration(observation);

  nodeOk.push(
    check(
      "Node hydration: islands hydrated over the SSR DOM, no browser error",
      hydrationFindings.length === 0,
      hydrationFindings.map((finding) => `${finding.class}: ${finding.detail}`).join("; "),
    ),
  );

  // Document navigation.
  section("Production server: document navigation (Router navigation stays NO-GO)");

  const tracked = await openTracked();

  try {
    const { page } = tracked;
    const hydrated = (): Promise<boolean> =>
      page.waitForSelector("add-to-cart[data-strata-hydrated]", { timeout: 15_000 }).then(
        () => true,
        () => false,
      );
    const count = (): Promise<string | null> =>
      page.locator("add-to-cart output:not(#stock)").textContent();

    await page.goto(`${node.baseUrl}/`, { waitUntil: "load" });
    await evaluate(page, "window.__NAV_SENTINEL__ = 'home'");
    const navigationsBefore = tracked.requests.filter((r) => r.navigation).length;

    await page.click("#to-product");
    await page.waitForURL("**/product");
    const direct = await hydrated();
    const sentinelAfterLink = await evaluate<string | undefined>(page, "window.__NAV_SENTINEL__");
    const linkNavigations = tracked.requests.filter((r) => r.navigation).length - navigationsBefore;

    await page.click("add-to-cart button");
    await page
      .waitForFunction(
        "document.querySelector('add-to-cart output:not(#stock)')?.textContent === 'Count: 1'",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const afterClick = await count();

    await page.click("#to-about");
    await page.waitForURL("**/about");
    await page.goBack();
    await page.waitForURL("**/product");
    const reentered = await hydrated();
    const afterBack = await count();

    await page.click("add-to-cart button");
    await page
      .waitForFunction(
        "document.querySelector('add-to-cart output:not(#stock)')?.textContent === 'Count: 1'",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    const afterReentryClick = await count();
    const islands = await evaluate<number>(
      page,
      "document.querySelectorAll('[data-strata-hydrated]').length",
    );

    nodeOk.push(
      check(
        "direct URL: the page hydrates and works",
        await (async () => {
          const fresh = await observeBrowser(`${node.baseUrl}/product`);
          return fresh.hydratedWithinTimeout && fresh.countAfterClick === "Count: 1";
        })(),
      ),
      check(
        "document link from / to /product: a real document request (the JS realm was replaced), the island hydrates",
        direct && sentinelAfterLink === undefined && linkNavigations === 1,
      ),
      check(
        "the island works after a document navigation (Count: 1)",
        afterClick === "Count: 1",
        String(afterClick),
      ),
      check(
        "Back / re-entry: the Server Component page is served and hydrated again, from a fresh state",
        reentered && afterBack === "Count: 0",
        `${reentered} ${afterBack}`,
      ),
      check(
        "after re-entry one click is one effect and both protocol islands exist",
        afterReentryClick === "Count: 1" && islands === 4,
        `${afterReentryClick}, ${islands} island(s)`,
      ),
      check(
        "no console error/warning during navigation",
        tracked.errors.length === 0,
        tracked.errors.join(" | "),
      ),
    );
  } finally {
    await tracked.close();
  }

  await node.stop();
  servers.length = 0;

  verdict.node = all(nodeOk);
  verdict.confidentiality = all(
    SERVER_MARKERS.map((marker) => filesWith(browser, marker).length === 0).concat(
      serverSourcesInBrowser.length === 0,
    ),
  );

  // ------------------------------------------------------------------------
  section("server-only firewall from the installed plugin (production builds)");

  const firewall: boolean[] = [];
  const addToCart = join(consumerDir, "src", "app", "product", "add-to-cart.component.ts");

  const expectBuildFailure = (
    label: string,
    mutate: (source: string) => string,
    mention: RegExp,
  ): void => {
    restoreDir(consumerDir, pristine!, NOT_SOURCE);
    writeFileSync(addToCart, mutate(readFileSync(addToCart, "utf8")));
    clean();

    const result = vite(["build"]);
    const output = sanitize(`${result.stdout}\n${result.stderr}`);
    const diagnostic =
      output.match(/\[strata\][^\n]*(?:\n(?:Imported from|Reason|Move|Import)[^\n]*)*/)?.[0] ?? "";

    firewall.push(
      check(`${label}: the production build fails`, result.status !== 0, output.slice(-800)),
      check(
        `${label}: the diagnostic comes from the installed plugin ([strata] …) and names the consumer module`,
        /\[strata\] Server-only module entered the browser graph: src\/app\/product\/product\.repository\.ts/.test(
          output,
        ) && mention.test(output),
        diagnostic,
      ),
      check(
        `${label}: it names the consumer importer, the server-only reason and the fix`,
        /Imported from: src\/app\/product\/add-to-cart\.component\.ts/.test(output) &&
          /Reason: the module declares `import "@strata-sc\/server-components\/server-only";`/.test(
            output,
          ) &&
          /Move the dependency behind the Server Component boundary/.test(output),
      ),
      check(
        `${label}: it names no Strata workspace path and no absolute path`,
        !output.includes(repoRoot) &&
          !/packages\/server-components\/src/.test(output) &&
          !output.includes(`${tmpRoot}/consumer/src`),
      ),
      check(
        `${label}: it prints neither a marker nor the module's contents`,
        SERVER_MARKERS.every((marker) => !output.includes(marker)),
      ),
    );
    restoreDir(consumerDir, pristine!, NOT_SOURCE);
    clean();
  };

  expectBuildFailure(
    "direct import",
    (source) =>
      `import { ProductRepository } from "./product.repository";\n${source.replace("protected readonly marker = CLIENT_MARKER;", "protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = ProductRepository.name;")}`,
    /./,
  );
  expectBuildFailure(
    "dynamic import",
    (source) => `${source}\nvoid import("./product.repository");\n`,
    /./,
  );
  expectBuildFailure(
    "?raw import",
    (source) =>
      `import raw from "./product.repository?raw";\n${source.replace("protected readonly marker = CLIENT_MARKER;", "protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = raw.length;")}`,
    /product\.repository\.ts\?raw/,
  );

  // Module resolution forms and package boundaries (docs/research/server-component-graph-security-v06.md).
  const KIT_CANARY = "STRATA_KIT_SERVER_ONLY_CANARY_6D1B94E2A07C";
  const KIT_MARKER = "STRATA_KIT_BROWSER_SAFE_MARKER";
  const REPOSITORY_MODULE = "src/app/product/product.repository.ts";
  const ASSERTS =
    /Reason: the module declares `import "@strata-sc\/server-components\/server-only";`/;
  const PACKAGE_ASSERTS =
    /Reason: the importer asserts server-only, but the pre-scan of sourceDir did not register it \(it lives outside sourceDir, for example in an installed or linked package/;
  const withLeak = (imports: string, member: string) => (source: string) =>
    `${imports}\n${source.replace("protected readonly marker = CLIENT_MARKER;", `protected readonly marker = CLIENT_MARKER;\n  protected readonly leak = ${member};`)}`;

  interface GraphScenario {
    readonly label: string;
    /** Extra or replaced consumer files, by consumer-relative path. */
    readonly files?: Record<string, string | ((source: string) => string)>;
    readonly module: string;
    readonly importer?: string;
    readonly reason: RegExp;
    /** The import chain line, when the bundler knows the importers (checked only if given). */
    readonly chain?: RegExp;
  }

  const expectGraphFailure = (scenario: GraphScenario): void => {
    const { label, files = {}, module, importer, reason, chain } = scenario;

    restoreDir(consumerDir, pristine!, NOT_SOURCE);
    for (const [path, content] of Object.entries(files)) {
      const target = join(consumerDir, path);

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        typeof content === "string" ? content : content(readFileSync(target, "utf8")),
      );
    }
    clean();

    const result = vite(["build"]);
    const output = sanitize(`${result.stdout}\n${result.stderr}`);
    const diagnostic =
      output.match(
        /\[strata\][^\n]*(?:\n(?:Imported from|Reason|Move|Import|A package)[^\n]*)*/,
      )?.[0] ?? "";

    console.log(`\n${label}:\n${diagnostic}`);

    const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

    firewall.push(
      check(`${label}: the production build fails`, result.status !== 0, output.slice(-800)),
      check(
        `${label}: the Strata diagnostic names the forbidden module (${module})`,
        new RegExp(`\\[strata\\] Server-only module entered the browser graph: ${escaped}`).test(
          output,
        ),
        output.match(/\[strata\][^\n]*/)?.[0] ?? output.slice(0, 600),
      ),
      check(`${label}: its Reason line is the intended invariant`, reason.test(output)),
      check(
        `${label}: it names the importer ${importer ?? "(not asserted)"}`,
        importer === undefined || output.includes(`Imported from: ${importer}`),
      ),
      check(
        `${label}: it prints the import chain the bundler knows`,
        chain === undefined || chain.test(output),
        output.match(/Import chain[^\n]*/)?.[0] ?? "(no chain line)",
      ),
      check(
        `${label}: the diagnostic names no workspace path and no absolute path`,
        !diagnostic.includes(repoRoot) &&
          !diagnostic.includes(tmpRoot) &&
          !/\s\/(?:Users|home|tmp|private|var)\//.test(diagnostic),
        diagnostic,
      ),
      check(
        `${label}: nothing printed carries a server-only marker`,
        [...SERVER_MARKERS, KIT_CANARY].every((marker) => !output.includes(marker)),
      ),
    );
    restoreDir(consumerDir, pristine!, NOT_SOURCE);
    clean();
  };

  const ADD_TO_CART = "src/app/product/add-to-cart.component.ts";
  const KIT = "node_modules/@strata-test/kit/dist";

  expectGraphFailure({
    label: "tsconfig path alias (@app/*)",
    files: {
      [ADD_TO_CART]: withLeak(
        `import { ProductRepository } from "@app/product/product.repository";`,
        "ProductRepository.name",
      ),
    },
    module: REPOSITORY_MODULE,
    importer: ADD_TO_CART,
    reason: ASSERTS,
  });
  expectGraphFailure({
    label: "Vite alias (~app)",
    files: {
      [ADD_TO_CART]: withLeak(
        `import { ProductRepository } from "~app/product/product.repository";`,
        "ProductRepository.name",
      ),
    },
    module: REPOSITORY_MODULE,
    importer: ADD_TO_CART,
    reason: ASSERTS,
  });
  expectGraphFailure({
    label: "aliased chained barrels through a directory index",
    files: {
      "src/app/product/data-barrel.ts": 'export * from "~app/product/product.repository";\n',
      "src/app/product/index.ts": 'export * from "@app/product/data-barrel";\n',
      [ADD_TO_CART]: withLeak(
        `import { ProductRepository } from "@app/product";`,
        "ProductRepository.name",
      ),
    },
    module: "src/app/product/index.ts",
    importer: ADD_TO_CART,
    reason:
      /Reason: it re-exports a server-only module: src\/app\/product\/index\.ts → src\/app\/product\/data-barrel\.ts → src\/app\/product\/product\.repository\.ts/,
  });
  expectGraphFailure({
    label: "aliased ?raw",
    files: {
      [ADD_TO_CART]: withLeak(
        `import raw from "~app/product/product.repository.ts?raw";`,
        "raw.length",
      ),
    },
    module: `${REPOSITORY_MODULE}?raw`,
    importer: ADD_TO_CART,
    reason: ASSERTS,
  });
  expectGraphFailure({
    label: "package subpath that asserts server-only",
    files: {
      [ADD_TO_CART]: withLeak(
        `import { readKitSecret } from "@strata-test/kit/server";`,
        "readKitSecret()",
      ),
    },
    module: `${KIT}/server.js`,
    importer: ADD_TO_CART,
    reason: PACKAGE_ASSERTS,
  });
  expectGraphFailure({
    label: "package barrel re-exporting a server-only entry",
    files: {
      [ADD_TO_CART]: withLeak(
        `import { formatPrice } from "@strata-test/kit/barrel";`,
        "formatPrice(100)",
      ),
    },
    module: `${KIT}/server.js`,
    importer: `${KIT}/barrel.js`,
    reason: PACKAGE_ASSERTS,
  });
  expectGraphFailure({
    label:
      "registered package island that asserts server-only (clientComponents does not authorize it)",
    files: {
      "vite.config.ts": (source) =>
        source.replace(
          "clientComponents: [",
          `clientComponents: [
        {
          selector: "acme-leaky-picker",
          module: "@strata-test/angular-widgets/leaky",
          exportName: "LeakyPickerComponent",
        },`,
        ),
      "src/app/product/product-details.server-component.ts": (source) =>
        source
          .replace(
            "import { ProductPickerComponent }",
            'import { LeakyPickerComponent } from "@strata-test/angular-widgets/leaky";\nimport { ProductPickerComponent }',
          )
          .replace(
            "ProductPickerComponent,\n",
            "ProductPickerComponent,\n    LeakyPickerComponent,\n",
          )
          .replace(
            "<legacy-counter",
            '<acme-leaky-picker [strataClient]="{}" />\n    <legacy-counter',
          ),
    },
    module: "node_modules/@strata-test/angular-widgets/dist/fesm2022/leaky.js",
    reason: PACKAGE_ASSERTS,
  });

  // Legal controls: the same alias and package forms, with nothing server-only behind them.
  restoreDir(consumerDir, pristine, NOT_SOURCE);
  writeFileSync(
    join(consumerDir, "src", "app", "product", "shared-format.ts"),
    "export function formatLabel(value: string): string {\n  return `shared:${value}`;\n}\n",
  );
  writeFileSync(
    join(consumerDir, "src", "app", "product", "types-barrel.ts"),
    'export type { ProductRepository } from "~app/product/product.repository";\nexport * from "@app/product/shared-format";\n',
  );
  writeFileSync(
    join(consumerDir, ADD_TO_CART),
    withLeak(
      `import { formatPrice } from "@strata-test/kit";
import { formatPrice as formatSafe } from "@strata-test/kit/safe";
import { formatLabel } from "~app/product/types-barrel";
import type { ProductRepository as RepositoryType } from "@app/product/types-barrel";`,
      "formatPrice(100) + formatSafe(200) + formatLabel('x')",
    )(readFileSync(join(consumerDir, ADD_TO_CART), "utf8")).replace(
      "protected readonly marker",
      "protected readonly unused?: RepositoryType;\n  protected readonly marker",
    ),
  );
  clean();

  const legal = vite(["build"]);
  const legalOutput = sanitize(`${legal.stdout}\n${legal.stderr}`);
  const legalBrowser = graphFiles(browserDirs);

  firewall.push(
    check(
      "legal control: aliased shared module, a type-only re-export and browser-safe package root and subpath build",
      legal.status === 0,
      legalOutput.slice(-1_200),
    ),
    check(
      "legal control: the browser-safe package marker reaches the browser JS",
      filesWith(
        legalBrowser.filter((file) => file.endsWith(".js")),
        KIT_MARKER,
      ).length > 0,
    ),
    check(
      "legal control: no server-only canary (consumer or package) reaches any browser file",
      [...SERVER_MARKERS, KIT_CANARY].every(
        (marker) => filesWith(legalBrowser, marker).length === 0,
      ),
    ),
  );
  restoreDir(consumerDir, pristine, NOT_SOURCE);
  clean();

  const restoredProblems = snapshotDiffers(consumerDir, pristine, NOT_SOURCE);

  firewall.push(
    check(
      "the consumer sources are back to their original bytes after the failing scenarios",
      restoredProblems.length === 0,
      restoredProblems.join(", "),
    ),
  );

  build("rebuild after the failing scenarios");
  firewall.push(
    check(
      "a failed scenario does not contaminate the next build: markers still split",
      SERVER_MARKERS.every((m) => filesWith(graphFiles(browserDirs), m).length === 0) &&
        filesWith(
          graphFiles(browserDirs).filter((f) => f.endsWith(".js")),
          MARKERS.client,
        ).length > 0,
    ),
  );
  verdict.firewall = all(firewall);

  // ------------------------------------------------------------------------
  section("Production compilation contract (AOT integrity) and cold-start SSR");

  const variantConfigs: string[] = [];

  // Control of the scan itself: it must see an uncompiled class and an unlinked partial declaration
  // (and accept a compiled module), or its green results on real builds would mean nothing.
  const scanProbe = join(tmpRoot, "scan-probe");

  mkdirSync(join(scanProbe, "ssr"), { recursive: true });
  writeFileSync(
    join(scanProbe, "ssr", "uncompiled.js"),
    'import { Component } from "@angular/core";\nlet A = class A {};\nA = __decorate([Component({})], A);\n',
  );
  writeFileSync(
    join(scanProbe, "ssr", "unlinked.js"),
    'i0.ɵɵngDeclareComponent({ minVersion: "14.0.0", version: "22.0.0" });\n',
  );
  writeFileSync(
    join(scanProbe, "ssr", "compiled.js"),
    "class B {}\nB.ɵcmp = i0.ɵɵdefineComponent({ type: B });\n",
  );

  const probed = scanBuildOutput(
    { classes: [join(scanProbe, "ssr")], partials: [join(scanProbe, "ssr")] },
    scanProbe,
  );

  integrity.push(
    check(
      "output scan control: finds the uncompiled class, the unlinked declaration, and accepts the compiled module",
      probed.uncompiled.length === 1 &&
        probed.uncompiled[0]?.file === "ssr/uncompiled.js" &&
        probed.unlinked.length === 1 &&
        probed.unlinked[0]?.file === "ssr/unlinked.js" &&
        probed.definitions === 1,
      describeScan(probed),
    ),
  );

  /** The consumer's own `vite.config.ts` with one more plugin in front, under another file name. */
  const variantConfig = (name: string, plugin: string): string => {
    const base = readFileSync(join(consumerDir, "vite.config.ts"), "utf8");

    if (!base.includes("plugins: ["))
      throw new Abort("the consumer vite.config.ts has no plugins array");

    writeFileSync(
      join(consumerDir, name),
      base.replace("plugins: [", `plugins: [\n    ${plugin},`),
    );
    variantConfigs.push(join(consumerDir, name));

    return name;
  };
  const discardVariants = (): void => {
    for (const file of variantConfigs.splice(0)) rmSync(file, { force: true });
  };
  const diagnosticOf = (output: string): string =>
    output.match(/\[strata\] AOT integrity:[^\n]*/)?.[0] ?? "";
  const noLeak = (text: string): boolean =>
    !text.includes(repoRoot) && !text.includes(tmpRoot) && !text.includes("app-product-page");

  // Negative control 1: a source-owned page the Angular compiler never sees. Analog skips it
  // without failing, so before this gate the build exited 0 and the first request returned HTTP 200
  // with the component missing and `JIT compiler unavailable` in the log.
  restoreDir(consumerDir, pristine, NOT_SOURCE);
  clean();

  const tsconfigApp = join(consumerDir, "tsconfig.app.json");

  writeFileSync(
    tsconfigApp,
    readFileSync(tsconfigApp, "utf8").replace(
      '"include": [',
      '"exclude": ["src/app/pages/product.page.ts"],\n  "include": [',
    ),
  );

  const outsideProgram = vite(["build"]);
  const outsideOutput = sanitize(`${outsideProgram.stdout}\n${outsideProgram.stderr}`);
  const outsideDiagnostic = diagnosticOf(outsideOutput);

  integrity.push(
    check(
      "page outside Angular's program: the production build fails (it used to exit 0)",
      outsideProgram.status !== 0,
      outsideOutput.slice(-800),
    ),
    check(
      "page outside Angular's program: the failure is the AOT integrity gate, naming the module, environment and class",
      /AOT integrity: "src\/app\/pages\/product\.page\.ts" \((?:ssr|client) build\)/.test(
        outsideDiagnostic,
      ) && outsideDiagnostic.includes("@Component ProductPage"),
      outsideDiagnostic || outsideOutput.slice(-600),
    ),
    check(
      "page outside Angular's program: the diagnostic explains the consequence and the cause",
      outsideDiagnostic.includes("JIT compiler unavailable") &&
        outsideDiagnostic.includes("tsconfig program"),
      outsideDiagnostic,
    ),
    check(
      "page outside Angular's program: the diagnostic carries no absolute path and no source text",
      outsideDiagnostic !== "" && noLeak(outsideDiagnostic),
      outsideDiagnostic,
    ),
  );
  restoreDir(consumerDir, pristine, NOT_SOURCE);
  clean();

  // Negative control 2: an installed Angular package whose partial declarations were never linked.
  // The control appends one declaration after Analog's linker has run, which is what a skipped or
  // bypassed linker leaves in the module.
  const linkerSkipped = variantConfig(
    "vite.control-unlinked.config.ts",
    `{
      name: "control-unlinked-package",
      enforce: "post" as const,
      transform(this: { environment?: { name: string } }, code: string, id: string) {
        if (this.environment?.name !== "ssr") return null;
        if (!id.includes("/node_modules/@strata-test/angular-widgets/dist/fesm2022/index.js")) return null;

        return { code: code + '\\nglobalThis.__control = i0.ɵɵngDeclareComponent({ minVersion: "14.0.0", version: "22.0.0", type: null });\\n', map: null };
      },
    }`,
  );
  const unlinked = vite(["build", "-c", linkerSkipped]);
  const unlinkedOutput = sanitize(`${unlinked.stdout}\n${unlinked.stderr}`);
  const unlinkedDiagnostic = diagnosticOf(unlinkedOutput);

  integrity.push(
    check("unlinked partial declaration: the production build fails", unlinked.status !== 0),
    check(
      "unlinked partial declaration: the gate names the installed package module and the linker",
      /AOT integrity: "node_modules\/@strata-test\/angular-widgets\/dist\/fesm2022\/index\.js" \(ssr build\)/.test(
        unlinkedDiagnostic,
      ) && unlinkedDiagnostic.includes("Angular linker did not process this package"),
      unlinkedDiagnostic || unlinkedOutput.slice(-600),
    ),
    check(
      "unlinked partial declaration: the diagnostic carries no absolute path",
      unlinkedDiagnostic !== "" && noLeak(unlinkedDiagnostic),
      unlinkedDiagnostic,
    ),
  );
  discardVariants();
  clean();

  // Positive control 3: the adversarial environment schedule. The client environment reaches its
  // buildEnd while the ssr environment is still transforming the page. Analog releases the shared
  // compilation at that point; the plugin's barrier must hold it back until ssr has finished.
  const raced = variantConfig(
    "vite.control-schedule.config.ts",
    `{
      name: "control-environment-schedule",
      enforce: "pre" as const,
      buildEnd(this: { environment?: { name: string } }) {
        if (this.environment?.name === "client") {
          console.log("[schedule] client buildEnd");
          releaseSchedule();
        }
      },
      async transform(this: { environment?: { name: string } }, _code: string, id: string) {
        if (this.environment?.name === "ssr" && id.endsWith("/src/app/pages/product.page.ts")) {
          console.log("[schedule] ssr transform of the page is held");
          await scheduleGate;
          await new Promise((resolve) => setTimeout(resolve, 1500));
          console.log("[schedule] ssr transform of the page resumes");
        }

        return null;
      },
    }`,
  );

  writeFileSync(
    join(consumerDir, raced),
    `let releaseSchedule: () => void = () => undefined;\nconst scheduleGate = new Promise<void>((resolve) => { releaseSchedule = resolve; });\n${readFileSync(join(consumerDir, raced), "utf8")}`,
  );
  clean();

  const schedule = time("consumer `vite build` under the adversarial environment schedule", () =>
    vite(["build", "-c", raced]),
  );
  const scheduleOutput = sanitize(`${schedule.stdout}\n${schedule.stderr}`);
  const held = scheduleOutput.indexOf("[schedule] ssr transform of the page is held");
  const clientEnded = scheduleOutput.indexOf("[schedule] client buildEnd");
  const resumed = scheduleOutput.indexOf("[schedule] ssr transform of the page resumes");

  integrity.push(
    check(
      "adversarial schedule: the page's ssr transform really resumed after the client buildEnd",
      held !== -1 && clientEnded !== -1 && resumed > clientEnded,
      `held@${held} clientEnd@${clientEnded} resumed@${resumed}`,
    ),
    check(
      "adversarial schedule: the build succeeds (the shared compilation outlives both environments)",
      schedule.status === 0,
      scheduleOutput.slice(-800),
    ),
    checkOutputContract("adversarial schedule"),
  );
  discardVariants();

  // Cold-start SSR over the final, valid build.
  build("production build for cold-start qualification");

  let coldStarts = 0;
  const coldStart = async (label: string, requests: number): Promise<void> => {
    const server = await startNodeServerCold(consumerDir, env);

    servers.push(server);
    coldStarts++;

    const replies = await overlapped(`${server.baseUrl}/product`, requests);
    const log = sanitize(server.output());

    integrity.push(
      ...replies.map((reply, index) =>
        assessProduct(`${label}, first request ${index + 1}/${requests}`, reply, log),
      ),
    );

    await server.stop();
    servers.pop();
  };

  await coldStart("cold start (single first request)", 1);
  await coldStart("cold start (overlapping first requests)", OVERLAPPING_FIRST_REQUESTS);

  // Repeated independent builds: every build starts from empty output and caches.
  for (let index = 1; index <= REPEATED_BUILDS; index++) {
    build(`independent production build ${index}/${REPEATED_BUILDS}`);
    await coldStart(
      `independent build ${index}/${REPEATED_BUILDS}, cold start`,
      OVERLAPPING_FIRST_REQUESTS,
    );
  }

  console.log(`cold starts: ${coldStarts}; independent rebuilds: ${REPEATED_BUILDS}`);

  // ------------------------------------------------------------------------
  section("External `vite` dev server (installed plugin, node_modules, no workspace)");

  const devOk: boolean[] = [];

  clean();

  const dev = await timeAsync("start dev server", () => startDevServer(consumerDir, env));

  servers.push(dev);

  const devTracked = await openTracked();
  const serverFile = join(
    consumerDir,
    "src",
    "app",
    "product",
    "product-details.server-component.ts",
  );

  try {
    const { page } = devTracked;
    const hydrated = (): Promise<boolean> =>
      page.waitForSelector("add-to-cart[data-strata-hydrated]", { timeout: 30_000 }).then(
        () => true,
        () => false,
      );
    const count = (): Promise<string | null> =>
      page.locator("add-to-cart output:not(#stock)").textContent();
    const click = async (expected: string): Promise<string | null> => {
      await page.click("add-to-cart button[data-product-id]");
      await page
        .waitForFunction(
          `document.querySelector('add-to-cart output:not(#stock)')?.textContent === ${JSON.stringify(expected)}`,
          undefined,
          { timeout: 5_000 },
        )
        .catch(() => undefined);

      return count();
    };

    await page.goto(`${dev.baseUrl}/product`, { waitUntil: "load" });
    const firstHydrated = await hydrated();
    const firstHtml = await httpGet(`${dev.baseUrl}/product`);

    devOk.push(
      check(
        "dev: SSR content and v1 + v2 boundaries",
        firstHtml.body.includes(SERVER_MESSAGE_A) &&
          /data-strata-protocol="1"/.test(firstHtml.body) &&
          /data-strata-protocol="2"/.test(firstHtml.body),
      ),
      check(
        "dev: the island hydrates (optimizeDeps.include works from node_modules)",
        firstHydrated,
      ),
      check("dev: one click, Count: 0 → Count: 1", (await click("Count: 1")) === "Count: 1"),
      check(
        "dev: no console error/warning (no JIT/compiler error)",
        devTracked.errors.length === 0,
        devTracked.errors.join(" | "),
      ),
      check(
        "dev: server log shows no JIT fallback and no missing-source-map warning",
        !/JIT compilation|needs to be compiled using the JIT|points to missing source files/.test(
          dev.output(),
        ),
        dev.output().slice(-800),
      ),
    );

    // One server-owned edit: document reload, fresh SSR, new realm.
    await evaluate(page, "window.__STRATA_DEV_REALM__ = 'old'");
    const mark = devTracked.requests.length;
    const logMark = dev.mark();

    writeFileSync(
      serverFile,
      readFileSync(serverFile, "utf8").replace(SERVER_MESSAGE_A, SERVER_MESSAGE_B),
    );

    const reloaded = await until(
      () => devTracked.requests.slice(mark).some((r) => r.navigation && r.type === "document"),
      30_000,
    );
    const newHydrated = await hydrated();
    const text = await page.locator("#server-message").textContent();
    const realm = await evaluate<string | undefined>(page, "window.__STRATA_DEV_REALM__");
    const islands = await evaluate<number>(
      page,
      "document.querySelectorAll('[data-strata-hydrated]').length",
    );
    const afterReload = await count();
    const afterClick = await click("Count: 1");
    const log = dev.since(logMark);
    const raw = await httpGet(`${dev.baseUrl}/product`);

    devOk.push(
      check("dev edit: the server-owned edit made the browser request a new document", !!reloaded),
      check(
        "dev edit: fresh SSR shows `External server B`, A is gone",
        text === SERVER_MESSAGE_B &&
          raw.body.includes(SERVER_MESSAGE_B) &&
          !raw.body.includes(SERVER_MESSAGE_A),
        String(text),
      ),
      check("dev edit: the old JS realm is gone (sentinel absent)", realm === undefined),
      check(
        "dev edit: the island hydrates once, starts at Count: 0 and one click is one effect",
        newHydrated && islands === 4 && afterReload === "Count: 0" && afterClick === "Count: 1",
        `${islands} island(s), ${afterReload} → ${afterClick}`,
      ),
      check(
        "dev edit: the packed plugin refreshed the graph and reloaded the document ([strata] log lines)",
        /\[strata\] graph refreshed/.test(log) &&
          /\[strata\][^\n]*reloading the document/.test(log),
        log.slice(-600),
      ),
      check(
        "dev edit: no console error/warning after the reload",
        devTracked.errors.length === 0,
        devTracked.errors.join(" | "),
      ),
    );
  } finally {
    writeFileSync(
      serverFile,
      readFileSync(join(fixtureTemplate, "src/app/product/product-details.server-component.ts")),
    );
    await devTracked.close();
    await dev.stop();
    servers.length = 0;
  }

  const devRestored = snapshotDiffers(consumerDir, pristine, NOT_SOURCE);

  devOk.push(
    check(
      "dev: the edited file is back to its original bytes",
      devRestored.length === 0,
      devRestored.join(", "),
    ),
  );
  verdict.dev = all(devOk);

  // ------------------------------------------------------------------------
  section("External Cloudflare Pages build and workerd (consumer-installed wrangler)");

  const cfOk: boolean[] = [];

  build("consumer `vite build` with BUILD_PRESET=cloudflare-pages", {
    BUILD_PRESET: "cloudflare-pages",
  });

  const nitroMeta = JSON.parse(readFileSync(dist("analog", "nitro.json"), "utf8")) as {
    preset?: string;
  };
  const workerDir = dist("analog", "public", "_worker.js");
  const worker = moduleGraph(workerDir, "index.js");
  const workerJs = worker.modules.map((module) => `analog/public/_worker.js/${module}`);
  const publicAssets = graphFiles(["analog/public", "client"], (file) =>
    file.startsWith("analog/public/_worker.js/"),
  );

  console.log(`Worker: ${worker.modules.length} reachable modules`);
  cfOk.push(
    check(
      "workerd and its public browser graph include the installed Angular package",
      workerJs.some((file) =>
        readFileSync(dist(file), "utf8").includes("STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT"),
      ) &&
        filesWith(
          publicAssets.filter((file) => file.endsWith(".js")),
          "STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT",
        ).length > 0,
    ),
    check(
      "the build resolves the cloudflare-pages preset",
      nitroMeta.preset === "cloudflare-pages",
      String(nitroMeta.preset),
    ),
    check(
      "a Worker was built (analog/public/_worker.js/index.js)",
      existsSync(join(workerDir, "index.js")),
    ),
  );
  for (const marker of SERVER_MARKERS) {
    cfOk.push(
      check(
        `${marker}: in the Worker graph`,
        workerJs.some((file) => readFileSync(dist(file), "utf8").includes(marker)),
      ),
      check(
        `${marker}: absent from the public browser assets`,
        filesWith(publicAssets, marker).length === 0,
        filesWith(publicAssets, marker).join(", "),
      ),
    );
  }
  cfOk.push(
    check(
      `${MARKERS.client}: in the public browser assets`,
      filesWith(
        publicAssets.filter((f) => f.endsWith(".js")),
        MARKERS.client,
      ).length > 0,
    ),
    check(
      "the Worker's unresolved imports are Node built-ins only (nodejs_compat is not enabled)",
      worker.externals.every(({ specifier }) => specifier.startsWith("node:") === false),
      worker.externals.map((e) => e.specifier).join(", "),
    ),
  );

  const wrangler = await timeAsync("start wrangler pages dev", () =>
    startWrangler(consumerDir, env),
  );

  servers.push(wrangler);

  const wranglerVersion = installedVersion(consumerDir, "wrangler");

  console.log(`wrangler (consumer-installed): ${wranglerVersion}`);

  const cfResponse = await httpGet(`${wrangler.baseUrl}/product`);

  cfOk.push(
    check(
      "workerd: GET /product 200 with the server-rendered content and computed evidence",
      cfResponse.status === 200 &&
        cfResponse.body.includes("<h1>Product 42</h1>") &&
        cfResponse.body.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
    ),
    check(
      "workerd: structured v2 and flat v1 boundaries are both written",
      /<add-to-cart data-strata-client="add-to-cart" data-strata-protocol="2" data-strata-props="[^"]*" ngh="\d+">/.test(
        cfResponse.body,
      ) &&
        /<legacy-counter data-strata-client="legacy-counter" data-strata-protocol="1" data-strata-props="\{&quot;start&quot;:0\}" ngh="\d+">/.test(
          cfResponse.body,
        ),
    ),
    check(
      "workerd: no server marker in the HTML",
      SERVER_MARKERS.every((m) => !cfResponse.body.includes(m)),
    ),
    check(
      "workerd: no code-generation or JIT error in the runtime log",
      !/Code generation from strings disallowed|JIT compilation|needs to be compiled using the JIT/.test(
        sanitize(wrangler.output()),
      ),
      sanitize(wrangler.output()).slice(-600),
    ),
  );

  cfOk.push(assessProduct("workerd SSR", cfResponse, sanitize(wrangler.output())));

  const cfBrowser = await observeBrowser(`${wrangler.baseUrl}/product`);

  cfOk.push(
    check(
      "workerd: the island hydrates by DOM identity",
      cfBrowser.hydratedWithinTimeout &&
        Object.values(cfBrowser.sameNodes).every(Boolean) &&
        cfBrowser.remainingHydrationAnnotations === 0 &&
        cfBrowser.hydratedIslands === 4,
    ),
    check(
      "workerd: one click, Count: 0 → Count: 1",
      cfBrowser.countAfterHydration === "Count: 0" && cfBrowser.countAfterClick === "Count: 1",
    ),
    check(
      "workerd: keyboard selection of a structured variant updates stock",
      cfBrowser.beforeScripts.stock === "In stock: 12" &&
        cfBrowser.stockAfterKeyboard === "In stock: 5" &&
        cfBrowser.selectedVariantAfterKeyboard === "true",
    ),
    check(
      "workerd: no console error/warning; no server marker in any loaded script",
      cfBrowser.errors.length === 0 &&
        cfBrowser.scripts.every((s) => SERVER_MARKERS.every((m) => !s.body.includes(m))),
      cfBrowser.errors.join(" | "),
    ),
  );

  const cfHydration = assessHydration(cfBrowser);

  cfOk.push(
    check(
      "workerd hydration: islands hydrated over the SSR DOM, no browser error",
      cfHydration.length === 0,
      cfHydration.map((finding) => `${finding.class}: ${finding.detail}`).join("; "),
    ),
  );

  await wrangler.stop();
  servers.length = 0;
  verdict.cloudflare = all(cfOk);

  // ------------------------------------------------------------------------
  section("The template and the package are untouched");

  const templateNow = snapshotDiffers(fixtureTemplate, templateBefore, () => false);

  check(
    "the fixture template in the repository is unchanged",
    templateNow.length === 0,
    templateNow.join(", "),
  );
  check(
    "the package manifest is unchanged by the qualification",
    (
      JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
        version: string;
      }
    ).version === sourceManifest.version,
  );
} catch (error) {
  if (!(error instanceof Abort)) {
    check(
      "the qualification ran to completion",
      false,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
} finally {
  for (const server of servers) await server.stop().catch(() => undefined);

  console.log(`\ntimings: ${timings.join("; ")}`);

  retainFailedOutput();

  if (process.env["STRATA_KEEP_CONSUMER"] === "1") {
    console.log(`kept: ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

verdict.compilation = all(contract) && all(integrity) && contract.length > 0;

section("Verdict");
check("tarball integrity", verdict.tarball);
check("declaration portability (TypeScript 5.9.2)", verdict.declarations59);
check("declaration portability (TypeScript 6)", verdict.declarations6);
check("external install", verdict.install);
check("Node production consumer", verdict.node);
check("server-only firewall from the installed plugin", verdict.firewall);
check("external dev server", verdict.dev);
check("Cloudflare/workerd consumer", verdict.cloudflare);
check("graph confidentiality", verdict.confidentiality);
check("production compilation integrity and cold-start SSR", verdict.compilation);

void __dirname;
void sleep;
void listFiles;
finish(TITLE);
