import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../lib/exec.ts";
import type { CommandResult } from "../lib/exec.ts";
import { copyDirRecursive } from "../lib/fs-helpers.ts";

import { FIXED_VERSIONS } from "./cases.ts";
import type { MatrixCase } from "./cases.ts";

interface ManifestShape {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface TsconfigShape {
  compilerOptions: Record<string, unknown>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function applyCompilerOptions(
  targetDir: string,
  matrixCase: Pick<MatrixCase, "lib" | "types">,
): void {
  const tsconfigPath = join(targetDir, "tsconfig.json");
  const tsconfig = readJson<TsconfigShape>(tsconfigPath);
  tsconfig.compilerOptions["lib"] = matrixCase.lib;
  tsconfig.compilerOptions["types"] = matrixCase.types;
  writeJson(tsconfigPath, tsconfig);
}

/**
 * Materializes the H3-only reproduction for one matrix case: no Strata
 * package is installed or referenced anywhere in this fixture.
 */
export function materializeH3OnlyFixture(
  sourceDir: string,
  targetDir: string,
  matrixCase: MatrixCase,
  h3Version: string = FIXED_VERSIONS.h3,
): void {
  copyDirRecursive(sourceDir, targetDir);

  const pkgPath = join(targetDir, "package.json");
  const pkg = readJson<ManifestShape>(pkgPath);
  pkg.dependencies = { h3: h3Version, ...matrixCase.dependencies };
  pkg.devDependencies = {
    typescript: FIXED_VERSIONS.typescript,
    "@types/node": FIXED_VERSIONS.typesNode,
    ...matrixCase.devDependencies,
  };
  writeJson(pkgPath, pkg);

  applyCompilerOptions(targetDir, matrixCase);
}

/**
 * Materializes the packed-Strata consumer check for one matrix case, reusing
 * the SPEC-001 authored controller fixture (`tests/consumer/fixture`) so the
 * same public behavior/metadata assertions and controller shape are reused
 * rather than re-demonstrated from scratch.
 */
export function materializeStrataConsumerFixture(
  sourceDir: string,
  targetDir: string,
  matrixCase: MatrixCase,
  corePath: string,
  h3TarballPath: string,
): void {
  copyDirRecursive(sourceDir, targetDir);

  const pkgPath = join(targetDir, "package.json");
  const pkg = readJson<ManifestShape>(pkgPath);
  pkg.dependencies = {
    ...pkg.dependencies,
    "@strata/core": `file:${corePath}`,
    "@strata/h3": `file:${h3TarballPath}`,
    h3: FIXED_VERSIONS.h3,
    ...matrixCase.dependencies,
  };
  pkg.devDependencies = {
    ...pkg.devDependencies,
    typescript: FIXED_VERSIONS.typescript,
    "@types/node": FIXED_VERSIONS.typesNode,
    ...matrixCase.devDependencies,
  };
  writeJson(pkgPath, pkg);

  applyCompilerOptions(targetDir, matrixCase);
}

export function materializeAmbientProbeFixture(
  sourceDir: string,
  targetDir: string,
  lib: string[],
  types: string[],
  devDependencies: Record<string, string>,
): void {
  copyDirRecursive(sourceDir, targetDir);

  const pkgPath = join(targetDir, "package.json");
  const pkg = readJson<ManifestShape>(pkgPath);
  pkg.devDependencies = {
    typescript: FIXED_VERSIONS.typescript,
    "@types/node": FIXED_VERSIONS.typesNode,
    ...devDependencies,
  };
  writeJson(pkgPath, pkg);

  applyCompilerOptions(targetDir, { lib, types });
}

export function npmInstall(dir: string): CommandResult {
  return run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
}

export function typecheck(dir: string): CommandResult {
  const tscBin = join(dir, "node_modules", ".bin", "tsc");
  return run(tscBin, ["-p", "tsconfig.json", "--noEmit"], { cwd: dir });
}

export function resolvedVersion(dir: string, packageName: string): string | null {
  const path = join(dir, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(path)) return null;
  return readJson<{ version: string }>(path).version;
}
