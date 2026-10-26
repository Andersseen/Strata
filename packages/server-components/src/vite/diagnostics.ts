import { basename, relative } from "node:path";

import { stripQuery } from "./module-id.js";
import { SERVER_ONLY_SPECIFIER, reExportChain } from "./server-only.js";
import type { ServerOnlyModule } from "./server-only.js";

/**
 * Why a module may never be loaded by Vite's `client` environment:
 * automatically for a `@ServerComponent()` module, explicitly for a module
 * asserting server-only (or a barrel re-exporting one).
 */
export type BrowserForbidden =
  | { readonly kind: "server-component"; readonly file: string }
  | { readonly kind: "server-only"; readonly module: ServerOnlyModule }
  | { readonly kind: "server-only-specifier" }
  | { readonly kind: "server-only-optimized" };

export interface BrowserGraphContext {
  readonly root: string;
  readonly serverOnly: ReadonlyMap<string, ServerOnlyModule>;
  /** Generated surrogate → the Server Component module it stands in for. */
  readonly surrogateOf: (id: string) => string | undefined;
}

/**
 * The import chain the bundler reported, from the outermost known importer
 * down to the importer of the forbidden module. Empty when it knows nothing.
 */
export type ImportChain = readonly string[];

const ASSERTION = `import "${SERVER_ONLY_SPECIFIER}";`;

/**
 * An app-relative path where the file is inside the app root, the path from
 * its last `node_modules/` segment for a dependency, and otherwise only the
 * file name: a diagnostic must not reveal where on the machine a file lives.
 */
export function displayPath(file: string, root: string): string {
  if (!file.startsWith("/")) return file;

  const path = relative(root, file);

  if (!path.startsWith("..")) return path;

  const marker = "/node_modules/";
  const at = file.lastIndexOf(marker);

  return at === -1 ? `<outside the app root>/${basename(file)}` : file.slice(at + 1);
}

function display(id: string, context: BrowserGraphContext): string {
  const file = stripQuery(id);
  const path = displayPath(file, context.root);
  const query = id.slice(file.length);
  const surrogate = context.surrogateOf(file);

  return `${path}${query}${
    surrogate
      ? ` (the generated browser surrogate of ${displayPath(surrogate, context.root)}, which imports its [strataClient] islands)`
      : ""
  }`;
}

function reasonOf(forbidden: BrowserForbidden, context: BrowserGraphContext): string {
  switch (forbidden.kind) {
    case "server-component":
      return "it declares a @ServerComponent() class. The browser graph may only contain its generated surrogate, and this path bypassed that replacement.";
    case "server-only-specifier":
      return `the importer asserts server-only, but the pre-scan of sourceDir did not register it (it lives outside sourceDir, for example in an installed or linked package, or the import is not the plain side-effect form \`${ASSERTION}\`). A package is not exempt from the server-only contract because it is listed in clientComponents or installed from npm.`;
    case "server-only-optimized":
      return `it declares \`${ASSERTION}\` and is part of a dependency the dev server pre-bundles for the browser (optimizeDeps). It is reached from a browser-visible import, directly, through a package re-export or through a dynamic import. Dependency pre-bundling collapses a package's internal imports, so only the importers the optimizer reports are listed and the app import that started the chain may be unavailable.`;
    case "server-only": {
      const { module } = forbidden;

      if (module.reason === "server-only-assertion") {
        return `the module declares \`${ASSERTION}\`.`;
      }

      const chain = reExportChain(module, context.serverOnly).map((file) =>
        displayPath(file, context.root),
      );

      return `it re-exports a server-only module: ${chain.join(" → ")}, which declares \`${ASSERTION}\`. A module that re-exports a server-only module is server-only for the browser.`;
    }
  }
}

function adviceOf(forbidden: BrowserForbidden): string {
  switch (forbidden.kind) {
    case "server-component":
      return "Import the Server Component only through Angular component imports, so its module resolves to the surrogate, and do not reach it through a glob import or a query.";
    case "server-only-optimized":
    case "server-only-specifier":
      return "Move the module behind the Server Component boundary, or into sourceDir so the assertion is checked at its own import site. A package that must run in the browser cannot import the server-only entry: remove that import from its browser entry points.";
    case "server-only":
      return forbidden.module.reason === "server-only-assertion"
        ? "Move the dependency behind the Server Component boundary (use it only from a @ServerComponent() or the server-owned components it renders, and pass plain data to the island through [strataClient]), or remove the browser import."
        : "Import the browser-safe exports from a module that does not re-export server-only code, or move the dependency behind the Server Component boundary.";
  }
}

/**
 * The build error for a forbidden module reaching the client environment:
 * which module, who imported it (when known), why, and what to do.
 */
export function browserGraphError(
  forbidden: BrowserForbidden,
  id: string,
  importer: string | undefined,
  context: BrowserGraphContext,
  chain: ImportChain = [],
): string {
  const title =
    forbidden.kind === "server-component"
      ? "Server Component module entered the browser graph"
      : "Server-only module entered the browser graph";

  return [
    `[strata] ${title}: ${display(id, context)}`,
    `Imported from: ${importer ? display(importer, context) : forbidden.kind === "server-only-optimized" ? "none known (it is an entry the dependency optimizer pre-bundles: a browser-visible import resolved to it directly)" : "unavailable (the bundler did not report an importer for this module, e.g. it was reached through a glob import)"}`,
    `Reason: ${reasonOf(forbidden, context)}`,
    adviceOf(forbidden),
    ...(chain.length > 1
      ? [
          `Import chain (the bundler's first importer at each step): ${chain.map((file) => display(file, context)).join(" → ")} → ${display(id, context)}`,
        ]
      : []),
  ].join("\n");
}
