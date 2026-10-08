import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

import { fingerprint, readServerHelper } from "./server-helper";

const SERVER_MARKER = "EXTERNAL_CONSUMER_SERVER_MARKER";

export interface Product {
  readonly id: string;
  readonly name: string;
  /** Computed at runtime from both server-only markers. */
  readonly provenance: string;
}

@Injectable({ providedIn: "root" })
export class ProductRepository {
  findById(id: string): Product {
    return {
      id,
      name: `Product ${id}`,
      provenance: `${fingerprint(SERVER_MARKER)}.${fingerprint(readServerHelper())}`,
    };
  }
}
