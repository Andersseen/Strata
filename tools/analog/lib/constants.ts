/** Emitted only by server-side fixture code (`src/server/strata/hello.controller.ts`). */
export const SERVER_MARKER = "STRATA_ANALOG_SERVER_ONLY_MARKER";

/** Emitted only by `src/server/strata/users.controller.ts`, the controller registered through `@strata-sc/analog`. */
export const CONTROLLER_MARKER = "STRATA_ANALOG_REGISTERED_CONTROLLER_MARKER";

/** Emitted only by `src/server/strata/greeting.controller.ts`, registered with a custom `controllerFactory`. */
export const FACTORY_MARKER = "STRATA_ANALOG_CONTROLLER_FACTORY_MARKER";

/** Emitted only by the Angular DI experiment under `src/server/strata/angular-di/`. */
export const ANGULAR_DI_MARKER = "STRATA_ANALOG_ANGULAR_DI_MARKER";

/** Emitted by a client page on purpose: a positive control for the output scan. */
export const CLIENT_MARKER = "STRATA_ANALOG_CLIENT_CONTROL_MARKER";

/** Description of a private symbol in `@strata-sc/core`'s metadata module. */
export const CORE_INTERNAL_SYMBOL = "strata:controller-definition";

/** Runtime-visible name of `@strata-sc/analog`'s error class: proves the adapter itself is in an output. */
export const ANALOG_ADAPTER_SYMBOL = "StrataAnalogConfigurationError";

/** Runtime-visible name of `@strata-sc/h3`'s error class: must never appear in an Analog build. */
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

/** What `GET /api/strata/users` must return, registered only through `@strata-sc/analog`. */
export const EXPECTED_USERS_BODY = [{ id: "1", name: "Ada" }];

/** What `GET /api/strata/users/:id` must return through Strata's request boundary. */
export const EXPECTED_USER_BODY = { id: "42", name: "Ada" };

/** What every `GET /api/strata/lifecycle` must return: a new controller instance per request. */
export const EXPECTED_LIFECYCLE_BODY = { calls: 1 };

/** What every `GET /api/strata/greeting` must return: per-request instance built by `controllerFactory`. */
export const EXPECTED_GREETING_BODY = { greeting: "hello", calls: 1 };
