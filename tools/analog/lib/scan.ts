import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Returns the files under `root` (relative to `root`) whose contents include
 * `needle`. Every file is read as UTF-8; a binary file simply never matches.
 */
export function findFilesContaining(root: string, needle: string): string[] {
  const matches: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && readFileSync(fullPath, "utf8").includes(needle)) {
        matches.push(relative(root, fullPath));
      }
    }
  }

  walk(root);

  return matches.sort();
}

/** Every file under `root`, as paths relative to `root`, sorted. */
export function listFiles(root: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath));
      }
    }
  }

  walk(root);

  return files.sort();
}
