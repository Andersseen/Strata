import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";
import type { CommandResult } from "../../consumer/lib/exec.ts";
import {
  EXCLUDED_PACKAGES,
  REGISTRY_PACKAGES,
  assertPublishSelection,
  inspectTarball,
  packPackage,
  readManifest,
} from "../../release/lib/packages.ts";
import type { PublishablePackage } from "../../release/lib/packages.ts";

import { check, repoRoot, section } from "./harness.ts";
import {
  findInstalledCopies,
  installedVersion,
  isSymlinkAnywhere,
  isUnder,
  readTarball,
  resolveFromConsumer,
  snapshotDir,
} from "./package-consumer.ts";
import type { Snapshot } from "./package-consumer.ts";

/**
 * The shared half of the two full-stack qualifications: build and `pnpm pack` the
 * three real packages, install ONLY those tarballs into a copy of
 * tests/full-stack-package-consumer/fixture outside the workspace, and prove the
 * tarball / lockfile / single-copy / entry-point identity. Used by
 * full-stack-consumer.ts and full-stack-deployed-cloudflare.ts.
 */

export const FULL_STACK_PACKAGES: readonly PublishablePackage[] = REGISTRY_PACKAGES;
export const [CORE, ANALOG, SERVER_COMPONENTS] = FULL_STACK_PACKAGES as [
  PublishablePackage,
  PublishablePackage,
  PublishablePackage,
];
const PACKAGES = FULL_STACK_PACKAGES;

export const fixtureTemplate = join(repoRoot, "tests", "full-stack-package-consumer", "fixture");

export const sanitize = (text: string): string => stripVTControlCharacters(text);
export const all = (results: readonly boolean[]): boolean => results.every(Boolean);

export class Abort extends Error {}

export function must(result: CommandResult, label: string): CommandResult {
  const ok = check(
    `${label} exits 0`,
    result.status === 0,
    sanitize(result.stderr || result.stdout).slice(-2_500),
  );

  if (!ok) throw new Abort(label);

  return result;
}

export const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export const sha512Integrity = (path: string): string =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

/** Everything under the consumer that is output or install, not authored source. */
export const NOT_SOURCE = (path: string): boolean =>
  /^(node_modules|dist|\.nitro|\.output|\.angular|package-lock\.json)(\/|$)/.test(path) ||
  path.startsWith("src/generated/");

export interface Tarball {
  readonly path: string;
  readonly sha256: string;
  readonly integrity: string;
}

export interface FullStackInstall {
  readonly manifests: readonly {
    pkg: PublishablePackage;
    manifest: ReturnType<typeof readManifest>;
  }[];
  readonly tarballs: ReadonlyMap<string, Tarball>;
  readonly consumerManifest: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  readonly installArgs: readonly string[];
  readonly pristine: Snapshot;
  readonly ok: boolean;
  readonly tarballOk: boolean;
  readonly installOk: boolean;
  /** Installed versions of the Angular/Analog/Nitro tuple, for evidence. */
  readonly tuple: Record<string, string>;
}

export function installFullStackConsumer(context: {
  readonly tmpRoot: string;
  readonly consumerDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly time: <T>(label: string, work: () => T) => T;
}): FullStackInstall {
  const { tmpRoot, consumerDir, env, time } = context;

  section("Release invariants: three registry-eligible packages, versions owned by Changesets");

  assertPublishSelection(PACKAGES);

  const manifests = PACKAGES.map((pkg) => ({
    pkg,
    manifest: readManifest(join(repoRoot, pkg.dir)),
  }));

  for (const { pkg, manifest } of manifests) {
    console.log(`manifest: ${manifest.name}@${manifest.version}`);
    check(
      `${pkg.name}@${manifest.version} is public and registry-eligible`,
      manifest.name === pkg.name && manifest.private === undefined,
    );
  }
  check(
    "@strata-sc/h3 stays excluded and is not part of this consumer",
    EXCLUDED_PACKAGES.includes("@strata-sc/h3") &&
      !PACKAGES.some((p) => p.name === "@strata-sc/h3"),
  );

  // ------------------------------------------------------------------------
  section("Build and pack the three real packages");

  for (const pkg of PACKAGES)
    rmSync(join(repoRoot, pkg.dir, "dist"), { recursive: true, force: true });
  time("package builds", () =>
    must(
      run("pnpm", [...PACKAGES.flatMap(({ name }) => ["--filter", name]), "run", "build"], {
        cwd: repoRoot,
      }),
      "pnpm build (core, analog, server-components)",
    ),
  );

  const tarballDir = join(tmpRoot, "tarballs");

  mkdirSync(tarballDir, { recursive: true });

  const tarballs = new Map<string, { path: string; sha256: string; integrity: string }>();
  const tarballOk: boolean[] = [];

  for (const pkg of PACKAGES) {
    const path = packPackage(repoRoot, pkg, tarballDir);
    const inspection = inspectTarball(repoRoot, path);
    const extracted = readTarball(
      path,
      join(tmpRoot, "extracted", pkg.dir.replace("packages/", "")),
    );
    const entry = { path, sha256: sha256(path), integrity: sha512Integrity(path) };

    tarballs.set(pkg.name, entry);
    console.log(
      `tarball: ${path.split("/").pop()}  ${inspection.sizeBytes} bytes  sha256 ${entry.sha256}\n  ${entry.integrity}`,
    );
    tarballOk.push(
      check(
        `${pkg.name} tarball is externally installable (release inspector: 0 problems)`,
        inspection.problems.length === 0,
        inspection.problems.join("; "),
      ),
      check(
        `${pkg.name} tarball: no workspace:/link:/portal:/file: range in any dependency field`,
        !/"(workspace|link|portal|file):/.test(
          JSON.stringify([
            extracted.manifest.dependencies,
            extracted.manifest.peerDependencies,
            extracted.manifest.optionalDependencies,
          ]),
        ),
      ),
    );
  }

  const packedAnalog = readTarball(
    tarballs.get(ANALOG.name)!.path,
    join(tmpRoot, "extracted-analog"),
  ).manifest;
  const coreVersion = manifests[0]!.manifest.version;

  tarballOk.push(
    check(
      "the packed @strata-sc/analog depends on @strata-sc/core by a concrete version equal to the packed core",
      packedAnalog.dependencies?.[CORE.name] === coreVersion,
      JSON.stringify(packedAnalog.dependencies),
    ),
  );

  // ------------------------------------------------------------------------
  section("External install (npm, outside the workspace, the three tarballs only)");

  check(
    "the consumer lives outside the repository",
    !consumerDir.startsWith(repoRoot) && !realpathSync(tmpRoot).startsWith(realpathSync(repoRoot)),
  );
  cpSync(fixtureTemplate, consumerDir, { recursive: true });

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
  check(
    "the fixture template declares all three Strata packages (the runner supplies the tarballs)",
    PACKAGES.every(({ name }) => consumerManifest.dependencies[name] === "REPLACED_BY_RUNNER"),
  );

  for (const pkg of PACKAGES) {
    consumerManifest.dependencies[pkg.name] = `file:${tarballs.get(pkg.name)!.path}`;
  }
  writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);
  const pristine = snapshotDir(consumerDir, NOT_SOURCE);

  const installArgs = ["install", "--no-audit", "--no-fund", "--loglevel=error"];

  console.log(
    `install command: npm ${installArgs.join(" ")}  (cwd ${consumerDir}; empty user config; npm_*/pnpm_*/NODE_PATH/NODE_OPTIONS removed)`,
  );
  time("npm install (consumer)", () =>
    must(run("npm", installArgs, { cwd: consumerDir, env }), "npm install"),
  );

  const installOk: boolean[] = [];
  const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };

  for (const pkg of PACKAGES) {
    const installed = join(consumerDir, "node_modules", pkg.name);
    const tarball = tarballs.get(pkg.name)!;
    const extractedDir = join(
      tmpRoot,
      pkg === ANALOG ? "extracted-analog" : join("extracted", pkg.dir.replace("packages/", "")),
    );
    const version = readManifest(join(repoRoot, pkg.dir)).version;
    const packedFiles = listFiles(extractedDir);
    const installedFiles = listFiles(installed).filter((f) => !f.startsWith("node_modules/"));
    const differing = packedFiles.filter(
      (file) =>
        !existsSync(join(installed, file)) ||
        sha256(join(installed, file)) !== sha256(join(extractedDir, file)),
    );
    const entry = lock.packages[`node_modules/${pkg.name}`];

    installOk.push(
      check(
        `${pkg.name}: a real directory (no symlink, junction or portal) at version ${version}`,
        existsSync(join(installed, "package.json")) &&
          !isSymlinkAnywhere(installed) &&
          lstatSync(installed).isDirectory() &&
          installedVersion(consumerDir, pkg.name) === version,
      ),
      check(
        `${pkg.name}: installed files are byte-identical to the tarball's (${packedFiles.length} files, no src/)`,
        differing.length === 0 &&
          installedFiles.join("\n") === packedFiles.join("\n") &&
          !existsSync(join(installed, "src")),
        differing.join(", "),
      ),
      check(
        `${pkg.name}: package-lock resolves it from the local tarball with the tarball's sha512 (never a registry)`,
        entry?.resolved?.startsWith("file:") === true &&
          !/^https?:/.test(entry.resolved) &&
          entry.integrity === tarball.integrity,
        JSON.stringify(entry),
      ),
      check(
        `${pkg.name}: exactly one installed copy`,
        findInstalledCopies(consumerDir, pkg.name).length === 1,
        findInstalledCopies(consumerDir, pkg.name).join(", "),
      ),
    );
  }

  const strataInstalled = readdirSync(join(consumerDir, "node_modules", "@strata-sc")).sort();

  installOk.push(
    check(
      "exactly @strata-sc/{analog,core,server-components} are installed (no @strata-sc/h3)",
      strataInstalled.join(",") === "analog,core,server-components",
      strataInstalled.join(","),
    ),
    check(
      "no lock entry resolves any @strata-sc package from a registry URL",
      Object.entries(lock.packages)
        .filter(([key]) => key.includes("@strata-sc/"))
        .every(([, value]) => value.resolved?.startsWith("file:") === true),
    ),
  );

  const installedAnalog = JSON.parse(
    readFileSync(join(consumerDir, "node_modules", ANALOG.name, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };

  installOk.push(
    check(
      "the installed @strata-sc/analog's @strata-sc/core dependency is the concrete packed version",
      installedAnalog.dependencies?.[CORE.name] === coreVersion,
      JSON.stringify(installedAnalog.dependencies),
    ),
  );

  const specifiers = [
    CORE.name,
    ANALOG.name,
    SERVER_COMPONENTS.name,
    `${SERVER_COMPONENTS.name}/vite`,
    `${SERVER_COMPONENTS.name}/navigation`,
    `${SERVER_COMPONENTS.name}/server-only`,
  ];
  const resolved = resolveFromConsumer(consumerDir, specifiers, env);

  for (const [specifier, url] of Object.entries(resolved))
    console.log(`resolve ${specifier} → ${url}`);

  installOk.push(
    check(
      "all six public entry points resolve to the packed dist/ files under consumer/node_modules",
      specifiers.every((s) => {
        const url = resolved[s]!;
        const name = s.startsWith(SERVER_COMPONENTS.name) ? SERVER_COMPONENTS.name : s;

        return (
          isUnder(url, join(consumerDir, "node_modules")) &&
          url.includes(`/node_modules/${name}/dist/`)
        );
      }),
    ),
    check(
      "nothing resolves into the Strata repository",
      Object.values(resolved).every(
        (url) => !realpathSync(new URL(url)).startsWith(realpathSync(repoRoot) + "/"),
      ),
    ),
  );

  const fromAnalog = resolveFromConsumer(
    join(consumerDir, "node_modules", ANALOG.name),
    [CORE.name],
    env,
  );

  installOk.push(
    check(
      "@strata-sc/analog resolves @strata-sc/core to the single packed core (not a registry copy)",
      fromAnalog[CORE.name] === resolved[CORE.name],
      `${fromAnalog[CORE.name]} vs ${resolved[CORE.name]}`,
    ),
  );

  const copiesOf = (name: string): string[] => findInstalledCopies(consumerDir, name);

  installOk.push(
    check(
      "one installed copy each of @angular/core, @angular/compiler and typescript",
      copiesOf("@angular/core").length === 1 &&
        copiesOf("@angular/compiler").length === 1 &&
        copiesOf("typescript").length === 1,
      [copiesOf("@angular/core"), copiesOf("@angular/compiler"), copiesOf("typescript")]
        .map((c) => c.join(","))
        .join(" | "),
    ),
  );

  const ls = run("npm", ["ls", "--all", "--json"], { cwd: consumerDir, env });
  const problems = (JSON.parse(ls.stdout || "{}") as { problems?: string[] }).problems ?? [];
  const problemName = (p: string): string => p.replace(/\s\/\S+$/, "");

  console.log(`npm ls --all: exit ${ls.status}; ${problems.length} problem(s)`);
  installOk.push(
    check(
      "npm ls --all reports no UNMET, invalid or extraneous Strata, Angular, Analog, Vite, TypeScript or Nitro package",
      problems.every(
        (p) =>
          !/UNMET|@strata-sc\/|@angular\/|@analogjs\/|\/vite|typescript|nitro|wrangler|rxjs|tslib/i.test(
            problemName(p),
          ),
      ),
      problems.join("; "),
    ),
  );

  const line = (names: readonly string[]): string =>
    names.map((name) => `${name}@${installedVersion(consumerDir, name)}`).join(", ");

  console.log(`node ${process.version}`);
  console.log(
    `tuple: ${line(["@angular/core", "@angular/common", "@angular/compiler", "@angular/router", "@angular/platform-browser", "@angular/platform-server", "@angular/compiler-cli", "@angular/build"])}`,
  );
  console.log(
    `       ${line(["@analogjs/platform", "@analogjs/router", "@analogjs/vite-plugin-angular", "@analogjs/vite-plugin-nitro", "nitropack", "h3", "vite", "typescript", "rxjs", "tslib", "wrangler"])}`,
  );

  const tuple = Object.fromEntries(
    [
      "@angular/core",
      "@angular/common",
      "@angular/compiler",
      "@angular/router",
      "@angular/platform-browser",
      "@angular/platform-server",
      "@angular/compiler-cli",
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
    ].map((name) => [name, installedVersion(consumerDir, name)]),
  );

  return {
    manifests,
    tarballs,
    consumerManifest,
    installArgs,
    pristine,
    ok: all([...tarballOk, ...installOk]),
    tarballOk: all(tarballOk),
    installOk: all(installOk),
    tuple,
  };
}
