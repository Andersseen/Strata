import { fingerprint } from "./fingerprint";

// Server-owned by construction: only the Nitro plugin under `src/server/` imports
// this module. It is the CONTROLLER runtime's data source and shares nothing with
// the Angular SSR repository in `src/app/products/`; the two are separate server
// bundles with independent lifetimes, and both are deterministic.
const CATALOG_MARKER = "FULLSTACK_CONTROLLER_CATALOG_MARKER";

export interface PublicProduct {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
}

const CATALOG: Readonly<Record<string, PublicProduct>> = {
  "42": { id: "42", name: "Product 42", available: true },
  "7": { id: "7", name: "Product 7", available: false },
};

/** Revealed only as a hash, so the browser-visible API proves the controller ran. */
export const CATALOG_FINGERPRINT = fingerprint(CATALOG_MARKER);

export function findPublicProduct(id: string): PublicProduct | undefined {
  return Object.hasOwn(CATALOG, id) ? CATALOG[id] : undefined;
}
