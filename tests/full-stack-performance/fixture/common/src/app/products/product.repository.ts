//@variant:server-only-import

import { Injectable } from "@angular/core";

import { fingerprint, readServerHelper } from "./server-helper";

const SERVER_MARKER = "PERF_CONSUMER_SERVER_MARKER";

// Confidential in the Server Component arms: the repository consumes it to derive
// a public price tier and never returns it. The plain-Angular arms ship it to the
// browser because an ordinary component graph is a browser graph.
const SUPPLIER_COST_CENTS = 7391047;
const PRIVATE_SUPPLIER_NOTE = "PERF_PRIVATE_SUPPLIER_CANARY_9f3c";

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly tier: "premium" | "standard";
  /** Computed at runtime from the server-owned markers and the private note. */
  readonly provenance: string;
}

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
