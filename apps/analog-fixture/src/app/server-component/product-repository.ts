import "@strata-sc/server-components/server-only";

import { Injectable } from "@angular/core";

import { readServerSecret } from "./server-secret";
import { formatShared } from "./shared-format";

// Emitted only by this server-only data access module. The side-effect import
// above asserts it: the build fails if any browser code imports this module.
const REPOSITORY_MARKER = "STRATA_SERVER_COMPONENT_REPOSITORY_MARKER";

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * Computed at runtime from both server-only modules' markers and rendered by
   * the server component, so no bundler can fold or tree-shake them away.
   */
  readonly provenance: string;
}

/** A stand-in for a database-backed repository. */
@Injectable({ providedIn: "root" })
export class ProductRepository {
  findById(id: string): Product {
    return {
      id,
      name: `Product ${id}`,
      description: "Server rendered product",
      provenance: formatShared(
        `${fingerprint(REPOSITORY_MARKER)}.${fingerprint(readServerSecret())}`,
      ),
    };
  }
}

/** A 32-bit string hash, evaluated at runtime. */
export function fingerprint(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  }

  return (hash >>> 0).toString(16);
}
