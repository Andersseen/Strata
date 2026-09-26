// Server-only by construction: nothing in the browser graph imports this
// module. It exists to prove the graph split is transitive — it is reached
// only through ProductRepository, never directly by the server component.
const TRANSITIVE_SERVER_ONLY_MARKER = "STRATA_TRANSITIVE_SERVER_ONLY_MARKER";

/** A stand-in for a credential or connection string the browser must never see. */
export function readServerSecret(): string {
  return TRANSITIVE_SERVER_ONLY_MARKER;
}
