//@variant:server-only-import

import { Injectable } from "@angular/core";

import { fingerprint } from "./server-helper";

const FULFILMENT_SERVER_MARKER = "PERF_FULFILMENT_SERVER_MARKER";

// Confidential in the Server Component arms, like the supplier note of the one-island profile:
// it is consumed to choose a public region and never returned.
const WAREHOUSE_COST_CENTS = 482113;
const PRIVATE_WAREHOUSE_NOTE = "PERF_PRIVATE_WAREHOUSE_CANARY_5b1d";

export interface Fulfilment {
  /** Public: the only value that reaches the delivery island. */
  readonly region: string;
  /** Computed at runtime from the server-owned marker and the private note. */
  readonly provenance: string;
}

@Injectable({ providedIn: "root" })
export class FulfilmentRepository {
  findById(id: string): Fulfilment | undefined {
    if (id !== "42" && id !== "7") return undefined;

    const cost = id === "42" ? WAREHOUSE_COST_CENTS : WAREHOUSE_COST_CENTS * 3;

    return {
      region: cost < 1_000_000 ? "EU-South" : "EU-North",
      provenance: `${fingerprint(FULFILMENT_SERVER_MARKER)}.${fingerprint(PRIVATE_WAREHOUSE_NOTE)}`,
    };
  }
}
