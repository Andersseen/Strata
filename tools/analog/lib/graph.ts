import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ResolvedPackage {
  name: string;
  version: string;
  /** Real (symlink-resolved) directory of the installed package. */
  dir: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
}

/**
 * Finds `name` the way Node's module resolution walks `node_modules`
 * directories upward from `fromDir` — deliberately ignoring `exports`, so
 * packages that hide their manifest can still be identified. Because `fromDir`
 * is symlink-resolved, pnpm's virtual store (and its hoisted `.pnpm/node_modules`
 * fallback) is traversed exactly as it is at runtime.
 */
export function resolvePackage(fromDir: string, name: string): ResolvedPackage | undefined {
  let dir = realpathSync(fromDir);

  for (;;) {
    const manifestPath = join(dir, "node_modules", name, "package.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;

      return {
        name,
        version: manifest.version ?? "unknown",
        dir: realpathSync(dirname(manifestPath)),
      };
    }

    const parent = dirname(dir);

    if (parent === dir) return undefined;

    dir = parent;
  }
}

export function requirePackage(fromDir: string, name: string): ResolvedPackage {
  const resolved = resolvePackage(fromDir, name);

  if (!resolved) {
    throw new Error(`Could not resolve "${name}" from ${fromDir}.`);
  }

  return resolved;
}

/**
 * Every `name@version` entry recorded in the `packages:` section of a pnpm
 * lockfile, grouped by package name.
 */
export function lockfileVersions(
  lockfilePath: string,
  names: readonly string[],
): Map<string, string[]> {
  const lines = readFileSync(lockfilePath, "utf8").split("\n");
  const start = lines.indexOf("packages:");
  const end = lines.indexOf("snapshots:");
  const wanted = new Set(names);
  const found = new Map<string, Set<string>>();

  for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
    const match = /^ {2}'?(@?[^@'\s]+)@([^'\s:]+)'?:$/.exec(line);
    const name = match?.[1];
    const version = match?.[2];

    if (name && version && wanted.has(name)) {
      found.set(name, (found.get(name) ?? new Set<string>()).add(version));
    }
  }

  return new Map([...found].map(([name, versions]) => [name, [...versions].sort()]));
}

export interface H3ApiFingerprint {
  entry: string;
  createApp: boolean;
  createRouter: boolean;
  createEvent: boolean;
  defineEventHandler: boolean;
  H3: boolean;
}

/**
 * Loads the `h3` that `fromDir` resolves and records which top-level APIs it
 * really exports. This is the observable difference between the H3 majors:
 * v1 is `createApp()`-based, v2 is the `H3` class.
 */
export async function fingerprintH3(fromDir: string): Promise<H3ApiFingerprint> {
  const entry = createRequire(join(realpathSync(fromDir), "noop.js")).resolve("h3");
  const namespace = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  const has = (key: string): boolean => key in namespace;

  return {
    entry,
    createApp: has("createApp"),
    createRouter: has("createRouter"),
    createEvent: has("createEvent"),
    defineEventHandler: has("defineEventHandler"),
    H3: has("H3"),
  };
}
