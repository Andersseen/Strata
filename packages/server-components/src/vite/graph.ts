import { dirname, join, relative } from "node:path";

import { analyzeServerComponent, createAnalysisCache } from "./analyze.js";
import type { ReadFile } from "./analyze.js";
import { scanServerOnlyModules } from "./server-only.js";
import type { ServerOnlyModule } from "./server-only.js";
import { renderSurrogate } from "./surrogate.js";
import type { ServerComponentModule } from "./surrogate.js";

/**
 * One consistent snapshot of everything the plugin derives from the app's
 * sources: which modules are Server Components and what their surrogates
 * contain, which modules are server-only, and which files a server render
 * depends on. Built whole by {@link buildServerComponentGraph}, compared with
 * {@link diffGraphs}, and replaced as a unit, never mutated. Private to the
 * plugin.
 */
export interface ServerComponentGraph {
  /** Authored Server Component module → its analysis. */
  readonly bySource: ReadonlyMap<string, ServerComponentModule>;
  /** Generated surrogate → the Server Component it stands in for. */
  readonly bySurrogate: ReadonlyMap<string, ServerComponentModule>;
  /** Modules the client environment must never load. */
  readonly serverOnly: ReadonlyMap<string, ServerOnlyModule>;
  /** Generated surrogate path → its exact contents. */
  readonly generated: ReadonlyMap<string, string>;
  /**
   * Files a server render depends on and the browser graph does not contain:
   * every Server Component module, the server-owned components, directives
   * and pipes it renders, and their `templateUrl` files.
   */
  readonly serverOwnedFiles: ReadonlySet<string>;
}

export interface GraphInput {
  readonly root: string;
  readonly sourceDir: string;
  readonly generatedDir: string;
  /** Absolute paths of the app's TypeScript sources, as listed at one instant. */
  readonly files: readonly string[];
  readonly readFile: ReadFile;
}

export const EMPTY_GRAPH: ServerComponentGraph = {
  bySource: new Map(),
  bySurrogate: new Map(),
  serverOnly: new Map(),
  generated: new Map(),
  serverOwnedFiles: new Set(),
};

/**
 * Analyzes every source in `input` and returns the graph they describe,
 * without touching the file system or any previous state: either the whole
 * graph, or a thrown analysis error and nothing else. Explicit server-only
 * assertions and re-export taint are scanned before the Server Components, as
 * in a production build.
 */
export function buildServerComponentGraph(input: GraphInput): ServerComponentGraph {
  const { root, sourceDir, generatedDir, files, readFile } = input;
  // Shared by every Server Component of this graph, so a child module
  // composed under several of them is parsed once.
  const cache = createAnalysisCache();
  const serverOnly = scanServerOnlyModules(files, readFile);
  const bySource = new Map<string, ServerComponentModule>();
  const bySurrogate = new Map<string, ServerComponentModule>();
  const generated = new Map<string, string>();
  const serverOwnedFiles = new Set<string>();

  for (const file of files) {
    const found = analyzeServerComponent(file, readFile(file), readFile, cache);

    if (!found) continue;

    const surrogate = join(generatedDir, relative(sourceDir, file));
    const module: ServerComponentModule = { file, surrogate, ...found };

    bySource.set(file, module);
    bySurrogate.set(surrogate, module);
    generated.set(surrogate, renderSurrogate(module, root));
    for (const owned of found.serverOwnedFiles) serverOwnedFiles.add(owned);
  }

  return { bySource, bySurrogate, serverOnly, generated, serverOwnedFiles };
}

/** What differs between two graphs; every list is sorted. */
export interface GraphDiff {
  readonly surrogatesAdded: readonly string[];
  readonly surrogatesChanged: readonly string[];
  readonly surrogatesRemoved: readonly string[];
  readonly serverOnlyAdded: readonly string[];
  readonly serverOnlyRemoved: readonly string[];
  /** Still server-only, but for a different reason or through another chain. */
  readonly serverOnlyChanged: readonly string[];
  readonly serverOwnedAdded: readonly string[];
  readonly serverOwnedRemoved: readonly string[];
  /**
   * Modules whose "the browser may not load this" status flipped, either way:
   * a Server Component module or a server-only one. Whatever Vite cached for
   * them, or for their importers, was decided under the other status.
   */
  readonly forbiddenFlipped: readonly string[];
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function missingFrom(keys: Iterable<string>, others: { has(key: string): boolean }): string[] {
  return sorted([...keys].filter((key) => !others.has(key)));
}

export function diffGraphs(previous: ServerComponentGraph, next: ServerComponentGraph): GraphDiff {
  const surrogatesChanged = sorted(
    [...next.generated].flatMap(([path, text]) => {
      const before = previous.generated.get(path);

      return before !== undefined && before !== text ? [path] : [];
    }),
  );
  const serverOnlyChanged = sorted(
    [...next.serverOnly].flatMap(([file, module]) => {
      const before = previous.serverOnly.get(file);

      return before && (before.reason !== module.reason || before.via !== module.via) ? [file] : [];
    }),
  );
  const forbidden = (graph: ServerComponentGraph): Set<string> =>
    new Set([...graph.bySource.keys(), ...graph.serverOnly.keys()]);
  const before = forbidden(previous);
  const after = forbidden(next);

  return {
    surrogatesAdded: missingFrom(next.generated.keys(), previous.generated),
    surrogatesChanged,
    surrogatesRemoved: missingFrom(previous.generated.keys(), next.generated),
    serverOnlyAdded: missingFrom(next.serverOnly.keys(), previous.serverOnly),
    serverOnlyRemoved: missingFrom(previous.serverOnly.keys(), next.serverOnly),
    serverOnlyChanged,
    serverOwnedAdded: missingFrom(next.serverOwnedFiles, previous.serverOwnedFiles),
    serverOwnedRemoved: missingFrom(previous.serverOwnedFiles, next.serverOwnedFiles),
    forbiddenFlipped: sorted([...missingFrom(after, before), ...missingFrom(before, after)]),
  };
}

/** Whether the ownership graph itself differs, as opposed to the content of a file in it. */
export function graphChanged(diff: GraphDiff): boolean {
  return [
    diff.surrogatesAdded,
    diff.surrogatesChanged,
    diff.surrogatesRemoved,
    diff.serverOnlyAdded,
    diff.serverOnlyRemoved,
    diff.serverOnlyChanged,
    diff.serverOwnedAdded,
    diff.serverOwnedRemoved,
    diff.forbiddenFlipped,
  ].some((list) => list.length > 0);
}

export interface ReloadDecision {
  readonly reload: boolean;
  /** Why, in the words the dev server logs. Empty when `reload` is false. */
  readonly reason: string;
}

/**
 * Whether an edit of `file`, already analyzed into `next`, needs a new
 * document (a fresh server render in a new browser realm) instead of the
 * framework's own module replacement.
 *
 * A Server Component's implementation is deliberately absent from the browser
 * graph, so it can never be hot-patched there: an edit to anything server-owned
 * (or to a server-only module) can only be seen by rendering again. A client
 * island edit that leaves the ownership graph and every surrogate identical is
 * none of that, and Angular/Vite replace it in place.
 */
export function decideReload(
  file: string,
  previous: ServerComponentGraph,
  next: ServerComponentGraph,
  diff: GraphDiff,
  recovered: boolean,
): ReloadDecision {
  const reload = (reason: string): ReloadDecision => ({ reload: true, reason });

  if (recovered) return reload("the graph was invalid and is valid again");
  if (graphChanged(diff)) return reload("the Server Component graph changed");
  if (previous.serverOwnedFiles.has(file) || next.serverOwnedFiles.has(file)) {
    return reload("a server-owned file changed");
  }
  if (previous.serverOnly.has(file) || next.serverOnly.has(file)) {
    return reload("a server-only module changed");
  }

  return { reload: false, reason: "" };
}

/** The file-system operations {@link syncGeneratedFiles} needs, replaceable in tests. */
export interface GeneratedFiles {
  /** Every file below `dir`, absolute; `[]` if `dir` does not exist. */
  list(dir: string): string[];
  read(path: string): string | undefined;
  write(path: string, text: string): void;
  remove(path: string): void;
  /** Removes `dir` and its now-empty parents up to (not including) `stop`. */
  pruneEmpty(dir: string, stop: string): void;
}

export interface GeneratedSync {
  readonly written: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Makes the files under `generatedDir` exactly `desired`: a missing file is
 * created, a different one rewritten, an identical one left alone (so the dev
 * server's watcher sees no event for it), and anything else under the
 * directory removed. Call it only with a graph that analyzed completely.
 */
export function syncGeneratedFiles(
  generatedDir: string,
  desired: ReadonlyMap<string, string>,
  files: GeneratedFiles,
): GeneratedSync {
  const written: string[] = [];
  const removed: string[] = [];

  for (const path of files.list(generatedDir)) {
    if (desired.has(path)) continue;

    files.remove(path);
    files.pruneEmpty(dirname(path), generatedDir);
    removed.push(path);
  }

  for (const [path, text] of desired) {
    if (files.read(path) === text) continue;

    files.write(path, text);
    written.push(path);
  }

  return { written: sorted(written), removed: sorted(removed) };
}
