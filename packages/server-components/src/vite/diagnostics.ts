import { relative } from "node:path";

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
  | { readonly kind: "server-only-specifier" };

export interface BrowserGraphContext {
  readonly root: string;
  readonly serverOnly: ReadonlyMap<string, ServerOnlyModule>;
  /** Generated surrogate → the Server Component module it stands in for. */
  readonly surrogateOf: (id: string) => string | undefined;
}

const ASSERTION = `import "${SERVER_ONLY_SPECIFIER}";`;

function display(id: string, context: BrowserGraphContext): string {
  const file = stripQuery(id);
  const path = file.startsWith("/") ? relative(context.root, file) : file;
  const query = id.slice(file.length);
  const surrogate = context.surrogateOf(file);

  return `${path}${query}${
    surrogate
      ? ` (the generated browser surrogate of ${relative(context.root, surrogate)}, which imports its [strataClient] islands)`
      : ""
  }`;
}

function reasonOf(forbidden: BrowserForbidden, context: BrowserGraphContext): string {
  switch (forbidden.kind) {
    case "server-component":
      return "it declares a @ServerComponent() class. The browser graph may only contain its generated surrogate, and this path bypassed that replacement.";
    case "server-only-specifier":
      return `the importer asserts server-only, but the pre-scan of sourceDir did not register it (it lives outside sourceDir, or the import is not the plain side-effect form \`${ASSERTION}\`).`;
    case "server-only": {
      const { module } = forbidden;

      if (module.reason === "server-only-assertion") {
        return `the module declares \`${ASSERTION}\`.`;
      }

      const chain = reExportChain(module, context.serverOnly).map((file) =>
        relative(context.root, file),
      );

      return `it re-exports a server-only module: ${chain.join(" → ")}, which declares \`${ASSERTION}\`. A module that re-exports a server-only module is server-only for the browser.`;
    }
  }
}

function adviceOf(forbidden: BrowserForbidden): string {
  switch (forbidden.kind) {
    case "server-component":
      return "Import the Server Component only through Angular component imports, so its module resolves to the surrogate, and do not reach it through a glob import or a query.";
    case "server-only-specifier":
      return "Move the module behind the Server Component boundary, or into sourceDir so the assertion is checked at its own import site.";
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
): string {
  const title =
    forbidden.kind === "server-component"
      ? "Server Component module entered the browser graph"
      : "Server-only module entered the browser graph";

  return [
    `[strata] ${title}: ${display(id, context)}`,
    `Imported from: ${importer ? display(importer, context) : "unknown (it was not reached through a relative import resolved by this plugin, e.g. a glob import or an alias)"}`,
    `Reason: ${reasonOf(forbidden, context)}`,
    adviceOf(forbidden),
  ].join("\n");
}
