import { Injectable } from "@angular/core";

import { SHOWCASE_GRAPH, fingerprint, transitiveProof } from "./server-component-proof";
import type { GraphModule } from "./server-component-proof";

// Qualification evidence (`pnpm test:www:server-components`); never rendered as text.
const REPOSITORY_MARKER = "STRATA_WWW_SERVER_REPOSITORY_MARKER";

export interface ServerComponentFacts {
  readonly runtime: string;
  readonly graph: readonly GraphModule[];
  readonly serverOnlyModules: number;
  readonly islandLabel: string;
  /** Opaque, computed at runtime from both server-only modules. */
  readonly provenance: string;
}

/**
 * A stand-in for a data source only the server may reach. Injected by the
 * landing's Server Component, so it never enters the browser graph.
 */
@Injectable({ providedIn: "root" })
export class ServerComponentFactsRepository {
  getFacts(): ServerComponentFacts {
    const graph = SHOWCASE_GRAPH;

    return {
      runtime: "Angular + Analog",
      graph,
      serverOnlyModules: graph.filter((module) => module.runtime === "server").length,
      islandLabel: "Run interaction",
      provenance: `${fingerprint(REPOSITORY_MARKER)}.${transitiveProof()}`,
    };
  }

  /** Opaque evidence that `value` was evaluated on the server. */
  evidenceFor(value: string): string {
    return fingerprint(value);
  }
}
