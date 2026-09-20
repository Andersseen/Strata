/** Emitted only by server-side fixture code (`src/server/strata/hello.controller.ts`). */
export const SERVER_MARKER = "STRATA_ANALOG_SERVER_ONLY_MARKER";

/** Emitted only by `src/server/strata/users.controller.ts`, the controller registered through `@strata/analog`. */
export const CONTROLLER_MARKER = "STRATA_ANALOG_REGISTERED_CONTROLLER_MARKER";

/** Emitted by a client page on purpose: a positive control for the output scan. */
export const CLIENT_MARKER = "STRATA_ANALOG_CLIENT_CONTROL_MARKER";

/** Description of a private symbol in `@strata/core`'s metadata module. */
export const CORE_INTERNAL_SYMBOL = "strata:controller-definition";

/** Runtime-visible name of `@strata/analog`'s error class: proves the adapter itself is in an output. */
export const ANALOG_ADAPTER_SYMBOL = "StrataAnalogConfigurationError";

/** Runtime-visible name of `@strata/h3`'s error class: must never appear in an Analog build. */
export const H3_ADAPTER_SYMBOL = "StrataH3ConfigurationError";

export const FIXTURE_PACKAGE = "@strata-fixtures/analog";

export const EXPECTED_HELLO_DEFINITION = {
  path: "/hello",
  routes: [{ method: "GET", path: "/", handler: "hello" }],
};

export const EXPECTED_PROBE_DEFINITION = {
  path: "/probe",
  routes: [{ method: "GET", path: "/", handler: "probe" }],
};

/** What `GET /api/strata/users` must return, registered only through `@strata/analog`. */
export const EXPECTED_USERS_BODY = [{ id: "1", name: "Ada" }];

/** What `GET /api/strata/users/:id` must return (routing only: no parameter extraction yet). */
export const EXPECTED_USER_BODY = { id: "1", name: "Ada" };
