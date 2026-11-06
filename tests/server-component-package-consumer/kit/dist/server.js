import "@strata-sc/server-components/server-only";

// A synthetic canary, not a secret.
const KIT_SERVER_CANARY = "STRATA_KIT_SERVER_ONLY_CANARY_6D1B94E2A07C";

export function readKitSecret() {
  // Computed at runtime: a bundler folds `.length` of a literal and drops the canary from the graph.
  return [...KIT_SERVER_CANARY].filter((character) => character !== " ").length;
}
