/** Emitted only by server-side fixture code (`src/server/strata/hello.controller.ts`). */
export const SERVER_MARKER = "STRATA_ANALOG_SERVER_ONLY_MARKER";

/** Emitted by a client page on purpose: a positive control for the output scan. */
export const CLIENT_MARKER = "STRATA_ANALOG_CLIENT_CONTROL_MARKER";

/** Description of a private symbol in `@strata/core`'s metadata module. */
export const CORE_INTERNAL_SYMBOL = "strata:controller-definition";

export const FIXTURE_PACKAGE = "@strata-fixtures/analog";

export const EXPECTED_HELLO_DEFINITION = {
  path: "/hello",
  routes: [{ method: "GET", path: "/", handler: "hello" }],
};

export const EXPECTED_PROBE_DEFINITION = {
  path: "/probe",
  routes: [{ method: "GET", path: "/", handler: "probe" }],
};
