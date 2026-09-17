import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function copyDirRecursive(sourceDir, targetDir) {
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
export function findScopedPackageDirs(rootNodeModules, scope, name) {
  const matches = [];

  function walk(dir) {
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
