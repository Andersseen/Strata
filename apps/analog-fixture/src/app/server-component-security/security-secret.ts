import "@strata-sc/server-components/server-only";

// A synthetic DATA canary, not a real credential. It stands for a value a
// Server Component may read and use but that must never reach any public
// browser surface (HTML, boundary props, hydration state, error responses,
// browser output, source maps): `pnpm test:server-component-security`.
// Distinct from the module canary of `server-component/server-secret.ts`,
// which proves graph isolation only.
const DATA_SECRET_CANARY = "STRATA_DATA_SECRET_CANARY_8E41B7D2A6F9";

/** FNV-1a (32-bit) of the credential's UTF-16 code units, as hex. Evaluated at runtime. */
export function digest(value: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }

  return hash.toString(16);
}

/** The digest the configuration check expects the credential to have. */
export const EXPECTED_CREDENTIAL_DIGEST = "80d39693";

/** A stand-in for a credential or connection string the browser must never see. */
export function readInternalCredential(): string {
  return DATA_SECRET_CANARY;
}
