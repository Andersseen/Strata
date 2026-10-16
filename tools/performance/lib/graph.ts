import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { listFiles } from "../../analog/lib/scan.ts";
import { isNodeBuiltin, moduleGraph } from "../../server-components/lib/module-graph.ts";

import { classifyFile, sizeOfFiles, totalsByClass } from "./metrics.ts";
import type { ClassTotal, FileClass, Size } from "./metrics.ts";

/**
 * Measures ONE Nitro production output (`dist/analog`) as four separate categories, never
 * mixed: the browser JavaScript users download, the server/Worker code that executes, the
 * complete deployable directory, and source maps/metadata on their own.
 */

export type Preset = "node-server" | "cloudflare-pages";

export interface BuildMeasurement {
  readonly preset: Preset;
  /** Browser JavaScript under `public/` (the Worker directory excluded; maps excluded). */
  readonly browser: {
    readonly js: Size & { readonly files: number };
    /** The module script the SSR document loads, alone. */
    readonly initialEntry: { readonly file: string } & Size;
    /** The entry plus everything it statically imports (what the first paint downloads). */
    readonly initialGraph: Size & { readonly files: number };
    /** Every other JS chunk: route chunks loaded on navigation. */
    readonly lazy: Size & { readonly files: number };
    readonly css: Size & { readonly files: number };
    /** Original-source modules named by the browser source maps, grouped by package. */
    readonly sourceModulesByPackage: Readonly<Record<string, number>>;
  };
  /** Server (`server/`) or Worker (`public/_worker.js/`) code, `node_modules/` excluded. */
  readonly server: {
    readonly entry: string;
    readonly bundledJs: Size & { readonly files: number };
    readonly entryEager: { readonly modules: number } & Size;
    readonly entryReachable: { readonly modules: number } & Size;
    readonly entrySize: Size;
    readonly chunks: readonly { readonly file: string; readonly bytes: number }[];
    readonly nodeBuiltins: readonly string[];
    readonly externalPackages: readonly string[];
    /** Nitro-traced runtime dependencies next to the bundle (Node only). */
    readonly tracedNodeModules: {
      readonly files: number;
      readonly bytes: number;
      readonly packages: readonly string[];
    };
  };
  /** Everything a deployment uploads: `dist/analog` (Node) or `dist/analog/public` (Pages). */
  readonly deployable: {
    readonly directory: string;
    readonly files: number;
    readonly bytes: number;
    readonly byClass: Readonly<Record<FileClass, ClassTotal>>;
  };
}

const sizeBytes = (path: string): number => statSync(path).size;

/** `node_modules/@scope/name/…` or `node_modules/name/…` → `@scope/name` | `name`; otherwise `app`. */
export function packageOfSource(source: string): string {
  const matches = [...source.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];

  if (matches.length > 0) return matches[matches.length - 1]![1]!;

  // Angular's own fesm bundles map to its Bazel build tree rather than node_modules.
  const angular = /\/bin\/packages\/([^/]+)\//.exec(source);

  if (angular) return `@angular/${angular[1]}`;

  return "app";
}

export function sourceModulesByPackage(mapFiles: readonly string[]): Record<string, number> {
  const seen = new Set<string>();
  const counts: Record<string, number> = {};

  for (const file of mapFiles) {
    const sources =
      (JSON.parse(readFileSync(file, "utf8")) as { sources?: string[] }).sources ?? [];

    for (const source of sources) {
      // The same module appearing in two chunks' maps is one module.
      const key = source.replace(/^(\.\.\/)+/, "");

      if (seen.has(key)) continue;
      seen.add(key);

      const name = packageOfSource(source);

      counts[name] = (counts[name] ?? 0) + 1;
    }
  }

  return counts;
}

/** The distinct package a bare specifier names (`@a/b/c` → `@a/b`, `x/y` → `x`). */
export const packageName = (specifier: string): string =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

export interface MeasureOptions {
  /** `dist/analog` of one production build. */
  readonly root: string;
  readonly preset: Preset;
  /** The browser module entry named by the SSR document, relative to `public/` (`assets/index-x.js`). */
  readonly entryScript: string;
}

export function measureBuild({ root, preset, entryScript }: MeasureOptions): BuildMeasurement {
  const publicDir = join(root, "public");
  const cloudflare = preset === "cloudflare-pages";
  const serverDir = cloudflare ? join(publicDir, "_worker.js") : join(root, "server");
  const serverEntry = cloudflare ? "index.js" : "index.mjs";
  const deployableDir = cloudflare ? publicDir : root;

  if (!existsSync(join(serverDir, serverEntry)))
    throw new Error(
      `No server entry at ${join(serverDir, serverEntry)}: a failed build is not a measurement.`,
    );
  if (!existsSync(join(publicDir, entryScript)))
    throw new Error(`The SSR document's entry ${entryScript} is not in ${publicDir}.`);

  const publicFiles = listFiles(publicDir).filter((file) => !file.startsWith("_worker.js/"));
  const publicJs = publicFiles.filter((file) => classifyFile(file) === "js");
  const abs = (file: string): string => join(publicDir, file);
  const initial = moduleGraph(publicDir, entryScript, { dynamic: false }).modules;
  const lazy = publicJs.filter((file) => !initial.includes(file));
  const withFiles = (files: readonly string[]) => ({
    ...sizeOfFiles(files.map(abs)),
    files: files.length,
  });

  const serverFiles = listFiles(serverDir).filter((file) => !file.startsWith("node_modules/"));
  const serverJs = serverFiles.filter((file) => classifyFile(file) === "js");
  const abss = (file: string): string => join(serverDir, file);
  const eager = moduleGraph(serverDir, serverEntry, { dynamic: false });
  const reachable = moduleGraph(serverDir, serverEntry);
  const sizeOfGraph = (modules: readonly string[]) => ({
    modules: modules.length,
    ...sizeOfFiles(modules.map(abss)),
  });
  const specifiers = [...new Set(reachable.externals.map((e) => e.specifier))];
  const tracedFiles =
    cloudflare || !existsSync(join(serverDir, "node_modules"))
      ? []
      : listFiles(join(serverDir, "node_modules"));
  const deployableFiles = listFiles(deployableDir);

  return {
    preset,
    browser: {
      js: withFiles(publicJs),
      initialEntry: { file: entryScript, ...sizeOfFiles([abs(entryScript)]) },
      initialGraph: withFiles(initial),
      lazy: withFiles(lazy),
      css: withFiles(publicFiles.filter((file) => classifyFile(file) === "css")),
      sourceModulesByPackage: sourceModulesByPackage(
        publicFiles.filter((file) => file.endsWith(".map")).map(abs),
      ),
    },
    server: {
      entry: serverEntry,
      bundledJs: { ...sizeOfFiles(serverJs.map(abss)), files: serverJs.length },
      entryEager: sizeOfGraph(eager.modules),
      entryReachable: sizeOfGraph(reachable.modules),
      entrySize: sizeOfFiles([abss(serverEntry)]),
      chunks: reachable.modules.map((file) => ({ file, bytes: sizeBytes(abss(file)) })),
      nodeBuiltins: specifiers.filter(isNodeBuiltin).sort(),
      externalPackages: [
        ...new Set(specifiers.filter((s) => !isNodeBuiltin(s)).map(packageName)),
      ].sort(),
      tracedNodeModules: {
        files: tracedFiles.length,
        bytes: tracedFiles.reduce(
          (sum, file) => sum + sizeBytes(join(serverDir, "node_modules", file)),
          0,
        ),
        packages: [
          ...new Set(
            tracedFiles.map((file) =>
              file.startsWith("@") ? file.split("/").slice(0, 2).join("/") : file.split("/")[0]!,
            ),
          ),
        ].sort(),
      },
    },
    deployable: {
      directory: cloudflare ? "dist/analog/public" : "dist/analog",
      files: deployableFiles.length,
      bytes: deployableFiles.reduce((sum, file) => sum + sizeBytes(join(deployableDir, file)), 0),
      byClass: totalsByClass(deployableFiles, (file) => sizeBytes(join(deployableDir, file))),
    },
  };
}

/** `src` of the module script, and every `modulepreload`, named by an SSR document. */
export function entryScriptOf(html: string): string | undefined {
  const match = /<script[^>]*type="module"[^>]*\ssrc="([^"]+)"/.exec(html);

  return match?.[1]?.replace(/^\//, "");
}

/** The browser files (everything public except the Worker) and the server's executable files. */
export function scanTargets(root: string, preset: Preset): { browser: string[]; server: string[] } {
  const publicDir = join(root, "public");
  const cloudflare = preset === "cloudflare-pages";
  const serverDir = cloudflare ? join(publicDir, "_worker.js") : join(root, "server");

  return {
    browser: listFiles(publicDir)
      .filter((file) => !file.startsWith("_worker.js/"))
      .map((file) => join(publicDir, file)),
    server: listFiles(serverDir)
      .filter((file) => !file.startsWith("node_modules/") && classifyFile(file) === "js")
      .map((file) => join(serverDir, file)),
  };
}

/** Marker → the files (as given) whose text contains it. A marker never found maps to `[]`. */
export function scanMarkers(
  files: readonly string[],
  markers: readonly string[],
): Record<string, string[]> {
  const found = Object.fromEntries(markers.map((marker) => [marker, [] as string[]]));

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    for (const marker of markers) if (text.includes(marker)) found[marker]!.push(file);
  }

  return found;
}
