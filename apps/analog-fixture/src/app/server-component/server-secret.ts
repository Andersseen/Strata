import "@strata-sc/server-components/server-only";

// Server-only by construction and by assertion: nothing in the browser graph
// imports this module, and the side-effect import above makes the build fail
// if anything ever does. It proves the graph split is transitive — it is
// reached only through ProductRepository, never directly by the server
// component.
const TRANSITIVE_SERVER_ONLY_MARKER = "STRATA_TRANSITIVE_SERVER_ONLY_MARKER";
// A synthetic canary, not a real secret: present in the server output, absent
// from every browser file and source map (`pnpm test:server-component-server-only`).
const SERVER_ONLY_CANARY = "STRATA_SERVER_ONLY_CANARY_7F3D9A41C2E5";

/** A stand-in for a credential or connection string the browser must never see. */
export function readServerSecret(): string {
  return `${TRANSITIVE_SERVER_ONLY_MARKER}:${SERVER_ONLY_CANARY}`;
}
