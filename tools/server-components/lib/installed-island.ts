import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { run } from "../../consumer/lib/exec.ts";
import type { CommandResult } from "../../consumer/lib/exec.ts";

import { check, repoRoot } from "./harness.ts";
import { isolatedEnv, restoreDir, snapshotDir } from "./package-consumer.ts";
import type { Snapshot } from "./package-consumer.ts";

/**
 * Workspace of `pnpm test:server-component-installed-island`: one real Strata tarball, two
 * independently partial-compiled versions of one Angular library, and an npm-installed consumer
 * outside the repository. Private to the repo.
 */

export const STRATA_PACKAGE = "@strata-sc/server-components";
export const WIDGETS_PACKAGE = "@strata-test/angular-widgets";
export const KIT_PACKAGE = "@strata-test/kit";

const testsDir = join(repoRoot, "tests", "server-component-package-consumer");
const packageDir = join(repoRoot, "packages", "server-components");

export const sanitize = (text: string): string => stripVTControlCharacters(text);

/** Everything under the consumer that is output or install, not authored source. */
export const NOT_SOURCE = (path: string): boolean =>
  /^(node_modules|dist|\.nitro|\.output|\.angular|package-lock\.json)(\/|$)/.test(path) ||
  path.startsWith("src/generated/");

export interface Workspace {
  readonly root: string;
  readonly consumerDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly strataTarball: string;
  readonly widgetsTarballs: { readonly v1: string; readonly v2: string };
  readonly kitTarball: string;
  readonly pristine: Snapshot;
  readonly reused: boolean;
  /** `npm install` of one widgets tarball into the consumer (an upgrade or downgrade). */
  installWidgets(version: "v1" | "v2"): CommandResult;
  /** The consumer's own `vite`, never the repository's. */
  vite(args: readonly string[], extraEnv?: NodeJS.ProcessEnv): CommandResult;
  /** Removes build outputs and generated surrogates (not node_modules). */
  clean(options?: { vite?: boolean }): void;
  restoreSources(): void;
  dispose(): void;
}

function must(result: CommandResult, label: string): CommandResult {
  const ok = check(
    `${label} exits 0`,
    result.status === 0,
    sanitize(result.stderr || result.stdout).slice(-2_500),
  );

  if (!ok) throw new Error(`${label} failed`);

  return result;
}

function onlyTarball(directory: string): string {
  const [name] = readdirSync(directory).filter((entry) => entry.endsWith(".tgz"));

  if (!name) throw new Error(`no tarball in ${directory}`);

  return join(directory, name);
}

/**
 * Applies the "v2" release of the library: same public components, a changed internal marker, one
 * new optional aliased input, one new subpath export. All are compatible with the v1 registration.
 */
export function applyWidgetsV2(directory: string): void {
  const index = join(directory, "src", "index.ts");
  const source = readFileSync(index, "utf8")
    .replace("STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT", "STRATA_PACKAGE_ANGULAR_WIDGET_CLIENT_V2")
    .replace(
      'readonly product = input.required<ProductView>({ alias: "productView" });',
      'readonly product = input.required<ProductView>({ alias: "productView" });\n  readonly heading = input<string | undefined>(undefined, { alias: "heading" });',
    );

  if (!source.includes("_V2")) throw new Error("widgets v2 transform did not apply");

  writeFileSync(index, source);

  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version: string;
    exports: Record<string, unknown>;
  };

  manifest.version = "0.0.1-test";
  manifest.exports["./extra"] = {
    types: "./dist/fesm2022/second.d.ts",
    default: "./dist/fesm2022/second.js",
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function packWidgets(root: string, label: string, env: NodeJS.ProcessEnv, v2: boolean): string {
  const directory = join(root, `angular-widgets-${label}`);
  const tarballs = join(root, `widgets-tarballs-${label}`);

  cpSync(join(testsDir, "angular-widgets"), directory, { recursive: true });
  rmSync(join(directory, "dist"), { recursive: true, force: true });
  mkdirSync(tarballs, { recursive: true });
  symlinkSync(join(packageDir, "node_modules"), join(directory, "node_modules"), "dir");
  if (v2) applyWidgetsV2(directory);

  must(
    run(
      "pnpm",
      ["--filter", STRATA_PACKAGE, "exec", "ngc", "-p", join(directory, "tsconfig.json")],
      {
        cwd: repoRoot,
      },
    ),
    `ngc partial-compiles ${WIDGETS_PACKAGE} ${label}`,
  );
  must(
    run(
      "npm",
      [
        "pack",
        "--pack-destination",
        tarballs,
        "--cache",
        join(root, "npm-cache"),
        "--logs-dir",
        join(root, "npm-logs"),
      ],
      { cwd: directory, env },
    ),
    `npm pack ${WIDGETS_PACKAGE} ${label}`,
  );

  return onlyTarball(tarballs);
}

/**
 * Builds the workspace. With `STRATA_INSTALLED_WORKDIR` pointing at an earlier workspace, nothing is
 * rebuilt or reinstalled (development only; the qualification run always starts clean).
 */
export function prepareWorkspace(): Workspace {
  const reuse = process.env["STRATA_INSTALLED_WORKDIR"];
  const root = reuse ?? mkdtempSync(join(tmpdir(), "strata-installed-island-"));
  const consumerDir = join(root, "consumer");
  const emptyNpmrc = join(root, "empty.npmrc");
  const emptyGlobalNpmrc = join(root, "empty-global.npmrc");
  const reused = reuse !== undefined && existsSync(join(consumerDir, "node_modules"));

  if (!reused) {
    mkdirSync(root, { recursive: true });
    writeFileSync(emptyNpmrc, "");
    writeFileSync(emptyGlobalNpmrc, "");
  }

  const env = isolatedEnv(emptyNpmrc, emptyGlobalNpmrc);
  const strataTarballs = join(root, "tarballs");
  const kitTarballs = join(root, "kit-tarballs");

  if (!reused) {
    rmSync(join(packageDir, "dist"), { recursive: true, force: true });
    must(
      run("pnpm", ["--filter", STRATA_PACKAGE, "run", "build"], { cwd: repoRoot }),
      "pnpm --filter @strata-sc/server-components build",
    );
    mkdirSync(strataTarballs, { recursive: true });
    must(
      run("pnpm", ["pack", "--pack-destination", strataTarballs], { cwd: packageDir }),
      "pnpm pack",
    );

    const kitDir = join(root, "kit");

    cpSync(join(testsDir, "kit"), kitDir, { recursive: true });
    mkdirSync(kitTarballs, { recursive: true });
    must(
      run(
        "npm",
        [
          "pack",
          "--pack-destination",
          kitTarballs,
          "--cache",
          join(root, "npm-cache"),
          "--logs-dir",
          join(root, "npm-logs"),
        ],
        { cwd: kitDir, env },
      ),
      `npm pack ${KIT_PACKAGE}`,
    );
    packWidgets(root, "v1", env, false);
    packWidgets(root, "v2", env, true);
  }

  const strataTarball = onlyTarball(strataTarballs);
  const widgetsTarballs = {
    v1: onlyTarball(join(root, "widgets-tarballs-v1")),
    v2: onlyTarball(join(root, "widgets-tarballs-v2")),
  };
  const kitTarball = onlyTarball(kitTarballs);

  const installArgs = [
    "install",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--cache",
    join(root, "npm-cache"),
    "--logs-dir",
    join(root, "npm-logs"),
    "--fetch-retries=0",
    "--fetch-timeout=30000",
  ];

  if (!reused) {
    cpSync(join(testsDir, "fixture"), consumerDir, { recursive: true });

    const manifestPath = join(consumerDir, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };

    manifest.dependencies[STRATA_PACKAGE] = `file:${strataTarball}`;
    manifest.dependencies[WIDGETS_PACKAGE] = `file:${widgetsTarballs.v1}`;
    manifest.dependencies[KIT_PACKAGE] = `file:${kitTarball}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    must(run("npm", installArgs, { cwd: consumerDir, env }), "npm install (consumer)");
  }

  const pristine = snapshotDir(consumerDir, NOT_SOURCE);

  return {
    root,
    consumerDir,
    env,
    strataTarball,
    widgetsTarballs,
    kitTarball,
    pristine,
    reused,
    installWidgets: (version) =>
      run(
        "npm",
        [
          "install",
          "--no-save",
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
          "--cache",
          join(root, "npm-cache"),
          "--logs-dir",
          join(root, "npm-logs"),
          widgetsTarballs[version],
        ],
        { cwd: consumerDir, env },
      ),
    vite: (args, extraEnv = {}) =>
      run(
        process.execPath,
        [join(consumerDir, "node_modules", "vite", "bin", "vite.js"), ...args],
        {
          cwd: consumerDir,
          env: { ...env, ...extraEnv },
        },
      ),
    clean: ({ vite = false } = {}) => {
      for (const directory of ["dist", "src/generated", ".nitro", ".angular"]) {
        rmSync(join(consumerDir, directory), { recursive: true, force: true });
      }
      if (vite)
        rmSync(join(consumerDir, "node_modules", ".vite"), { recursive: true, force: true });
    },
    restoreSources: () => {
      restoreDir(consumerDir, pristine, NOT_SOURCE);
    },
    dispose: () => {
      if (process.env["STRATA_KEEP_CONSUMER"] === "1" || reuse !== undefined) {
        console.log(`kept: ${root}`);
      } else {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

/** Writes `content` (or a transform of the existing file) at a consumer-relative path. */
export function writeConsumerFile(
  consumerDir: string,
  path: string,
  content: string | ((source: string) => string),
): void {
  const target = join(consumerDir, path);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    typeof content === "string" ? content : content(readFileSync(target, "utf8")),
  );
}
