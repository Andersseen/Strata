import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

import { fingerprint, readServerHelper } from "./server-helper";

const SERVER_MARKER = "FULLSTACK_CONSUMER_SERVER_MARKER";

// Confidential: the repository consumes it to derive a public price tier and
// never returns it. It must appear in no HTML, prop, API response or browser file.
const SUPPLIER_COST_CENTS = 7391047;
const PRIVATE_SUPPLIER_NOTE = "FULLSTACK_PRIVATE_SUPPLIER_CANARY_9f3c";

export interface Product {
  readonly id: string;
  readonly name: string;
  /** Computed on the server from the confidential cost. */
  readonly tier: "premium" | "standard";
  /** Computed at runtime from the server-only markers and the private note. */
  readonly provenance: string;
}

/** The Angular SSR runtime's own deterministic source (not shared with the controller). */
@Injectable({ providedIn: "root" })
export class ProductRepository {
  findById(id: string): Product | undefined {
    if (id !== "42" && id !== "7") return undefined;

    const cost = id === "42" ? SUPPLIER_COST_CENTS : SUPPLIER_COST_CENTS / 100;

    return {
      id,
      name: `Product ${id}`,
      tier: cost > 5_000_000 ? "premium" : "standard",
      provenance: `${fingerprint(SERVER_MARKER)}.${fingerprint(readServerHelper())}.${fingerprint(PRIVATE_SUPPLIER_NOTE)}`,
    };
  }
}
