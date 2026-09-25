import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function copyDirRecursive(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

/**
 * Finds every directory whose path ends in `@strata/core`, so the runner can
 * assert the isolated consumer install resolved exactly one copy.
 */
export function findScopedPackageDirs(
  rootNodeModules: string,
  scope: string,
  name: string,
): string[] {
  const matches: string[] = [];

  function walk(dir: string): void {
    let entries;

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;

      const fullPath = join(dir, entry.name);

      if (entry.name === scope) {
        const candidate = join(fullPath, name);

        if (statSync(join(candidate, "package.json"), { throwIfNoEntry: false })) {
          matches.push(candidate);
        }
      }

      walk(fullPath);
    }
  }

  walk(rootNodeModules);

  return matches;
}

/**
 * The file name `pnpm pack` gives a workspace package's tarball
 * (`@strata/core@0.1.0` → `strata-core-0.1.0.tgz`), read from its current
 * package.json so runners follow Changesets version bumps.
 */
export function packedTarballName(packageDir: string): string {
  const { name, version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };

  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}
