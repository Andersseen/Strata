// Asserted server-only: the build fails if any browser code imports this module.
import "@strata-sc/server-components/server-only";

// Server-only by construction: only ServerComponentFactsRepository imports this
// module, never the server component itself. It keeps the landing's graph split
// transitive, the property the section describes. Qualification evidence
// (`pnpm test:www:server-components`); never rendered as text.
const TRANSITIVE_SERVER_MARKER = "STRATA_WWW_TRANSITIVE_SERVER_MARKER";

/** Where each module of the showcase is allowed to run. */
export type ModuleRuntime = "server" | "browser";

export interface GraphModule {
  readonly name: string;
  readonly role: string;
  readonly runtime: ModuleRuntime;
}

/** The module graph behind the section, as the build splits it. */
export const SHOWCASE_GRAPH: readonly GraphModule[] = [
  { name: "ServerComponentsShowcase", role: "Server Component", runtime: "server" },
  { name: "ServerComponentFactsRepository", role: "Injected service", runtime: "server" },
  { name: "server-component-proof", role: "Transitive import", runtime: "server" },
  { name: "ServerComponentDemo", role: "Client island", runtime: "browser" },
];

/** A 32-bit string hash, evaluated at runtime so no bundler can fold it away. */
export function fingerprint(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}

/** Opaque proof that this module executed while rendering. */
export function transitiveProof(): string {
  return fingerprint(TRANSITIVE_SERVER_MARKER);
}
