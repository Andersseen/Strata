import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getControllerDefinition } from "@strata-sc/core";
import type { HttpMethod, RouteDefinition } from "@strata-sc/core";

import {
  buildAllow,
  compareSpecificity,
  compilePattern,
  headResponse,
  isCorsPreflight,
  isUnderPrefix,
  matchPattern,
  methodNotAllowedResponse,
  notFoundResponse,
  optionsResponse,
  parseApiBoundary,
  prefixesOverlap,
  shapeOf,
  splitRequestPath,
} from "./api-boundary.js";
import type {
  BoundaryRequest,
  NativeEntry,
  Segment,
  StrataAnalogApiBoundaryOptions,
  StrataAnalogBoundaryMethod,
} from "./api-boundary.js";
import { CleanupScope } from "./cleanup-scope.js";
import type { StrataAnalogCleanup } from "./cleanup-scope.js";
import { StrataAnalogConfigurationError } from "./errors.js";
import { StrataAnalogHttpError } from "./http-error.js";
import { StrataAnalogInputError } from "./input-error.js";
import { InvocationObservation } from "./request-observation.js";
import type { StrataAnalogRequestObserver } from "./request-observation.js";
import { claimStreamResponse } from "./stream-lifecycle.js";
import { buildRoutePath } from "./utils/build-route-path.js";

export type StrataAnalogQueryValue = string | readonly string[];

export type StrataAnalogQuery = Readonly<Record<string, StrataAnalogQueryValue>>;

export type StrataAnalogParams = Readonly<Record<string, string>>;

/**
 * Schema input for `validateHeaders()`: a frozen, request-local snapshot with
 * lowercase names and string values. Repeated fields are already combined by
 * the native `Headers` API (joined with ", "); nothing is split or coerced.
 */
export type StrataAnalogHeaders = Readonly<Record<string, string>>;

export type StrataAnalogContext = Readonly<Record<string, unknown>>;

export interface StrataAnalogRequest {
  readonly method: string;
  readonly path: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly params: StrataAnalogParams;
  readonly query: StrataAnalogQuery;
  readonly context: StrataAnalogContext;
  readBody: () => Promise<unknown>;
  readText: () => Promise<string>;
  readJson: <T = unknown>() => Promise<T>;
  validateParams: <Schema extends StandardSchemaV1>(
    schema: Schema,
  ) => Promise<StandardSchemaV1.InferOutput<Schema>>;
  validateQuery: <Schema extends StandardSchemaV1>(
    schema: Schema,
  ) => Promise<StandardSchemaV1.InferOutput<Schema>>;
  validateHeaders: <Schema extends StandardSchemaV1>(
    schema: Schema,
  ) => Promise<StandardSchemaV1.InferOutput<Schema>>;
  readValidatedJson: <Schema extends StandardSchemaV1>(
    schema: Schema,
  ) => Promise<StandardSchemaV1.InferOutput<Schema>>;
  readValidatedForm: <Schema extends StandardSchemaV1>(
    schema: Schema,
  ) => Promise<StandardSchemaV1.InferOutput<Schema>>;
}

/** Stable description of the registered route being evaluated by a guard. */
export interface StrataAnalogRouteInfo {
  readonly method: HttpMethod;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
}

export type StrataAnalogGuardDecision =
  { readonly allow: true } | { readonly allow: false; readonly status: 401 | 403 };

export interface StrataAnalogGuardContext {
  readonly request: StrataAnalogRequest;
  readonly route: StrataAnalogRouteInfo;
  readonly onCleanup: (cleanup: StrataAnalogCleanup) => void;
}

/** Downstream interceptor and controller execution for this request. */
export type StrataAnalogNext = () => Promise<unknown>;

/** Request-local view available to an interceptor; framework internals stay private. */
export interface StrataAnalogInterceptorContext {
  readonly request: StrataAnalogRequest;
  readonly route: StrataAnalogRouteInfo;
  readonly onCleanup: (cleanup: StrataAnalogCleanup) => void;
}

/** Wraps controller execution. Every normally settling interceptor must await exactly one next(). */
export type StrataAnalogInterceptor = (
  context: StrataAnalogInterceptorContext,
  next: StrataAnalogNext,
) => unknown;

/** Consumer-owned request authorization check, run sequentially before construction. */
export type StrataAnalogGuard = (
  context: StrataAnalogGuardContext,
) => StrataAnalogGuardDecision | Promise<StrataAnalogGuardDecision>;

/**
 * A Strata controller class, as passed to {@link registerControllers}.
 *
 * `@strata-sc/core` types controller classes as abstract constructors (it only
 * ever reads their metadata), but this adapter must be able to instantiate
 * them, so it narrows the requirement to a concrete, no-argument
 * constructor.
 */
export type ControllerClass = new () => object;

/**
 * What a {@link StrataAnalogControllerFactory} receives besides the controller
 * class: the Strata request the new controller instance is created for, and a
 * way to release what the factory creates for it.
 *
 * Experimental: more request-scoped information may be added here later.
 */
export interface StrataAnalogControllerFactoryContext {
  /** The same `StrataAnalogRequest` object the handler is then invoked with. */
  readonly request: StrataAnalogRequest;
  /**
   * Registers a callback that releases a resource created for this
   * controller invocation (an Angular request injector, a transaction, …).
   *
   * Every registered cleanup runs exactly once, after the factory and the
   * awaited handler call have settled — on success, when the factory throws
   * or rejects, and when the handler throws or rejects. Cleanups run one at a
   * time, last registered first (LIFO), each awaited before the next, and the
   * route handler settles only after all of them.
   *
   * The scope is the controller invocation, not the HTTP response: cleanup
   * does not wait for a response body to be consumed, unless the handler
   * returns a `streamResponse()`, which keeps the scope open until its body
   * completes, fails or is cancelled.
   *
   * Calling it once the invocation has finished throws a
   * `StrataAnalogConfigurationError`. It does not depend on `this`, so it can
   * be destructured.
   */
  readonly onCleanup: (cleanup: StrataAnalogCleanup) => void;
}

/**
 * Creates the controller instance for one request. Called once per matched
 * request, before the route handler, and never cached by Strata.
 *
 * It must return (or resolve to) an instance of `controller`. It may throw or
 * reject; that error propagates to Nitro unchanged, after the cleanups it had
 * registered with `context.onCleanup` have run.
 *
 * Experimental: this is the seam where an external lifecycle — e.g. Angular
 * DI, by wrapping `new controller()` in an injection context the consumer
 * owns — can take part in controller creation. Strata itself provides no
 * injector or container.
 */
export type StrataAnalogControllerFactory = (
  controller: ControllerClass,
  context: StrataAnalogControllerFactoryContext,
) => object | Promise<object>;

/** Options accepted by {@link registerControllers}. Experimental. */
export interface RegisterControllersOptions {
  /**
   * Creates each request's controller instance. Defaults to
   * `new controller()`.
   */
  readonly controllerFactory?: StrataAnalogControllerFactory;
  /** Opt-in request guards, evaluated in order before controller creation. */
  readonly guards?: readonly StrataAnalogGuard[];
  /** Opt-in onion-style wrappers, entered in order after guards. */
  readonly interceptors?: readonly StrataAnalogInterceptor[];
  /**
   * Opt-in ownership of API path prefixes: unknown paths below them answer a
   * safe JSON 404, known paths with an unsupported method answer 405 with
   * `Allow`, and `HEAD`/`OPTIONS` follow the documented policy. Without it,
   * routing is exactly what Nitro does.
   */
  readonly apiBoundary?: StrataAnalogApiBoundaryOptions;
  /**
   * Opt-in observation of each Strata controller invocation's end, exactly once,
   * after its cleanups settled (for an owned `streamResponse()`, when its body
   * completes, fails or is cancelled). Synchronous and isolated: it is neither
   * awaited nor able to change the response or error. Native Nitro routes, the
   * API boundary's own 404/405 answers and Analog server functions are not
   * observed. See the package README.
   */
  readonly onRequestSettled?: StrataAnalogRequestObserver;
}

type ControllerHandler = (this: object, request: StrataAnalogRequest) => unknown;

const defaultControllerFactory: StrataAnalogControllerFactory = (controller) => new controller();

/**
 * Strata's HTTP method names → the lowercase names Nitro's router expects.
 * `satisfies Record<HttpMethod, …>` makes this a compile error, not a silent
 * mis-registration, the day `@strata-sc/core` adds a method.
 */
const ROUTER_METHOD = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
} as const satisfies Record<HttpMethod, Lowercase<HttpMethod>>;

type RouterMethod = (typeof ROUTER_METHOD)[HttpMethod];

/**
 * Nitro's H3 v1 router registers a handler for every method when none is
 * given, and its runtime accepts `"all"` for it; its public `add()` type just
 * does not list it. The boundary fallback needs that, and nothing else does.
 */
const ALL_METHODS = "all" as unknown as RouterMethod;

/**
 * The part of Nitro 2's router that Strata uses: `nitroApp.router`, the
 * `Router` Nitro itself registers its file-system routes on.
 *
 * It is declared structurally, and deliberately, instead of importing
 * `Router` from `h3` or `NitroApp` from `nitropack`:
 *
 * - Analog 2 runs on Nitro 2, which runs on H3 **v1**. `@strata-sc/analog`
 *   never touches an H3 v1 (or v2) type, value or import, so it neither
 *   depends on a Nitro/H3 major nor leaks one into its declarations.
 * - The Nitro `Router` is assignable to this interface as-is — no cast. That
 *   is verified against Nitro's real types by the `test:analog` fixture.
 *
 * The handler receives Nitro/H3's event internally, converts it to Strata's
 * own request boundary, and passes that boundary to controller methods. The
 * public controller API never receives the H3 event itself.
 */
export interface NitroRouter {
  add(path: string, handler: (event: NitroEvent) => unknown, method: RouterMethod): unknown;
}

/**
 * Registers one or more Strata controllers on the Nitro router of an Analog
 * app. Call it from a Nitro server plugin, which is where Nitro hands out the
 * router:
 *
 * ```ts
 * export default defineNitroPlugin((nitroApp) => {
 *   registerControllers(nitroApp.router, [UsersController]);
 * });
 * ```
 *
 * For each controller this:
 *
 * 1. reads its declarative metadata via `getControllerDefinition`;
 * 2. resolves each route handler on the controller's prototype, without
 *    creating an instance;
 * 3. registers each Strata route (`@Get()`, `@Post()`, `@Put()`, `@Patch()`,
 *    `@Delete()`) on `router` for its HTTP method, joining the controller
 *    path and route path into the final route path;
 * 4. wires each route so that every matching request gets its own
 *    `StrataAnalogRequest`, its own controller instance, and a call to the
 *    handler with that instance as `this` and that request as argument. The
 *    result goes directly to Nitro/H3, which serializes it natively (objects
 *    and arrays become JSON).
 *
 * Controller lifecycle (experimental): controllers are request-scoped. No
 * instance is created at registration; each matched request creates a new
 * one with `options.controllerFactory` (default: `new ControllerClass()`),
 * uses it for that request's handler call, and drops it. Instances are never
 * pooled, cached or shared between requests. Cleanups the factory registers
 * with `onCleanup` run after that handler call settles, whatever the outcome.
 *
 * Errors: if cleanups fail, none of the errors is hidden. A single cleanup
 * error after a successful invocation is thrown as is; otherwise the original
 * invocation error (if any) and every cleanup error are thrown together as an
 * `AggregateError`, after all cleanups have been attempted.
 *
 * Request input boundary (provisional): controller methods may accept one
 * `StrataAnalogRequest` argument. It contains route params, query values,
 * headers, method, URL/path, a shallow context snapshot, and lazy body readers
 * without exposing Nitro's H3 v1 event type or requiring a dependency on H3.
 *
 * Registration validates eagerly and as a whole batch: a class without
 * `@Controller()` metadata, a route whose handler isn't a method on the
 * controller's prototype chain, a `controllerFactory` that isn't a function,
 * or a route whose HTTP method and final path another Strata route already
 * owns on this router (in this call or an earlier one) throws a
 * {@link StrataAnalogConfigurationError} before the router is touched, so a
 * failed call registers nothing. Repeated calls with non-overlapping routes
 * are fine, and the same routes may be registered on different routers.
 * Duplicate detection only sees Strata registrations, not native routes.
 * Registration is atomic with respect to Strata configuration validation; it
 * is not transactional against errors `router.add()` itself throws while
 * routes are being added: that error propagates and routes added before it
 * stay registered. A factory that returns something other than an
 * instance of the controller class throws the same error at request time;
 * any error the factory itself throws or rejects with propagates unchanged.
 *
 * API boundary (opt-in): `options.apiBoundary` makes explicitly listed path
 * prefixes an API namespace. Below them, a request no route handled answers a
 * safe JSON 404, a known path with an unsupported method answers 405 with
 * `Allow`, `HEAD` is derived from the matching `GET` route and plain `OPTIONS`
 * can be answered (never a CORS preflight). It is a fallback registered on
 * `/<prefix>` and `/<prefix>/**` that Nitro's router only reaches when no more
 * specific route handles the method, so native routes are never shadowed. See
 * the package README.
 *
 * Strata does not replace Nitro or Analog — this only adds routes to the
 * router you pass in. Native Analog routes (`src/server/routes/**`) keep
 * working exactly as before.
 */
export function registerControllers<Router extends NitroRouter>(
  router: Router,
  controllers: readonly ControllerClass[],
  options: RegisterControllersOptions = {},
): Router {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new StrataAnalogConfigurationError("registerControllers() options must be an object.");
  }
  const controllerFactory = options.controllerFactory ?? defaultControllerFactory;

  if (typeof controllerFactory !== "function") {
    throw new StrataAnalogConfigurationError(
      "registerControllers() option `controllerFactory` must be a function.",
    );
  }

  const guardValue: unknown = options.guards === undefined ? [] : options.guards;
  if (!Array.isArray(guardValue) || !guardValue.every(isStrataAnalogGuard)) {
    throw new StrataAnalogConfigurationError(
      "registerControllers() option `guards` must be an array of functions.",
    );
  }
  const guardSnapshot = Object.freeze(guardValue.filter(isStrataAnalogGuard));

  const interceptorValue: unknown = options.interceptors === undefined ? [] : options.interceptors;
  if (!Array.isArray(interceptorValue) || !interceptorValue.every(isStrataAnalogInterceptor)) {
    throw new StrataAnalogConfigurationError(
      "registerControllers() option `interceptors` must be an array of functions.",
    );
  }
  const interceptorSnapshot = Object.freeze(interceptorValue.slice());

  const observer: unknown = options.onRequestSettled;
  if (observer !== undefined && typeof observer !== "function") {
    throw new StrataAnalogConfigurationError(
      "registerControllers() option `onRequestSettled` must be a function.",
    );
  }

  const boundary =
    options.apiBoundary === undefined ? undefined : parseApiBoundary(options.apiBoundary);

  const plan = planRegistration(
    router,
    controllers,
    controllerFactory,
    guardSnapshot,
    interceptorSnapshot,
    boundary,
    observer as StrataAnalogRequestObserver | undefined,
  );

  commitRegistration(router, plan);

  return router;
}

function isStrataAnalogGuard(value: unknown): value is StrataAnalogGuard {
  return typeof value === "function";
}

function isStrataAnalogInterceptor(value: unknown): value is StrataAnalogInterceptor {
  return typeof value === "function";
}

/** Route identity on one router: HTTP method + final path, e.g. `GET /api/users`. */
type RouteKey = `${HttpMethod} ${string}`;

/** A validated route, ready to be added to the router. */
interface PlannedRoute {
  readonly key: RouteKey;
  /** `Controller.handler`, for diagnostics. */
  readonly owner: string;
  readonly path: string;
  readonly httpMethod: HttpMethod;
  readonly method: RouterMethod;
  readonly handler: (event: NitroEvent) => unknown;
}

/** A route Strata registered on a router, as the boundary needs to see it. */
interface RegisteredRoute {
  readonly owner: string;
  readonly path: string;
  readonly method: HttpMethod;
  readonly handler: (event: NitroEvent) => unknown;
}

/** An owned prefix on one router, with the policy it was declared under. */
interface BoundaryEntry {
  readonly prefix: string;
  readonly head: "derive" | "off";
  readonly options: "allow" | "off";
  /** Strata routes below the prefix, most specific first. Grows with later batches. */
  routes: BoundaryRoute[];
  /** Declared native routes below the prefix. */
  native: NativeEntry[];
}

interface BoundaryRoute {
  readonly route: RegisteredRoute;
  readonly segments: readonly Segment[];
}

/**
 * Everything Strata knows about one router: the routes it registered
 * (route key → route) and the API prefixes it owns. Scoped to the router by a
 * `WeakMap`, never retained past it and never attached to it: routes added by
 * Nitro, Analog or anyone else are not visible here, and nothing is shared
 * between routers or server lifetimes.
 */
interface RouterState {
  readonly routes: Map<RouteKey, RegisteredRoute>;
  readonly boundaries: Map<string, BoundaryEntry>;
}

const routerStates = new WeakMap<NitroRouter, RouterState>();

/** The outcome of validating a boundary request against a router's state. */
interface BoundaryPlan {
  /** Prefixes this call introduces; already-owned prefixes only gain routes. */
  readonly newPrefixes: readonly string[];
  /** The call's `apiBoundary`; absent when a later call only adds routes to owned prefixes. */
  readonly request: BoundaryRequest | undefined;
}

/**
 * Validates the whole batch — every controller, handler and route key, and the
 * API boundary — without touching the router or its state, so a configuration
 * error leaves both exactly as they were.
 */
function planRegistration(
  router: NitroRouter,
  controllers: readonly ControllerClass[],
  controllerFactory: StrataAnalogControllerFactory,
  guards: readonly StrataAnalogGuard[],
  interceptors: readonly StrataAnalogInterceptor[],
  boundary: BoundaryRequest | undefined,
  observer: StrataAnalogRequestObserver | undefined,
): { routes: PlannedRoute[]; boundary: BoundaryPlan | undefined } {
  const state = routerStates.get(router);
  const registered = state?.routes;
  const planned = new Map<RouteKey, PlannedRoute>();
  const routeShapes = new Map<
    string,
    { owner: string; path: string; method: HttpMethod; previous: boolean }
  >();

  for (const route of registered?.values() ?? []) {
    const segments = compilePattern(route.path);
    if (!segments) continue;
    const shape = shapeOf(segments);
    const known = routeShapes.get(shape);
    if (!known) {
      routeShapes.set(shape, {
        owner: route.owner,
        path: route.path,
        method: route.method,
        previous: true,
      });
    }
  }

  for (const controllerClass of controllers) {
    const definition =
      typeof controllerClass === "function" ? getControllerDefinition(controllerClass) : undefined;

    if (!definition) {
      throw new StrataAnalogConfigurationError(
        `${describeController(controllerClass)} is not a Strata controller. Did you forget to add @Controller()?`,
      );
    }

    for (const route of definition.routes) {
      const handler = resolveRouteHandler(controllerClass, route);
      const path = buildRoutePath(definition.path, route.path);
      const key: RouteKey = `${route.method} ${path}`;
      const owner = `${controllerClass.name}.${route.handler}`;
      const registeredOwner = registered?.get(key)?.owner;
      const plannedOwner = planned.get(key)?.owner;

      if (registeredOwner !== undefined || plannedOwner !== undefined) {
        const where =
          registeredOwner !== undefined
            ? "already registered on this router"
            : "declared earlier in the same registerControllers() call";

        throw new StrataAnalogConfigurationError(
          `Duplicate Strata route "${key}": "${owner}" conflicts with "${registeredOwner ?? plannedOwner}", ${where}. ` +
            "Each HTTP method and final path may be registered by only one Strata route per router.",
        );
      }

      const segments = compilePattern(path);
      if (segments) {
        const shape = shapeOf(segments);
        const equivalent = routeShapes.get(shape);

        // Nitro/H3 shares the parameter name stored for a structural path
        // across methods. The same template is safe for multiple methods, but
        // a different parameter name can be delivered to every method based
        // on which template was registered first.
        if (equivalent && equivalent.path !== path) {
          const where = equivalent.previous
            ? "against a previously registered Strata route on this router"
            : "within the current registerControllers() batch";
          throw new StrataAnalogConfigurationError(
            `Ambiguous Strata routes: ${route.method} ${path} (${owner}) conflicts with ` +
              `${equivalent.method} ${equivalent.path} (${equivalent.owner}), ${where}. ` +
              "Parameter names do not create distinct Nitro routes and Nitro shares parameter metadata across HTTP methods. " +
              "Change a static path segment to give the routes different structural paths.",
          );
        }

        if (!equivalent) {
          routeShapes.set(shape, { owner, path, method: route.method, previous: false });
        }
      }

      planned.set(key, {
        key,
        owner,
        path,
        httpMethod: route.method,
        method: ROUTER_METHOD[route.method],
        handler: createRouteHandler(
          controllerClass,
          handler,
          controllerFactory,
          guards,
          interceptors,
          Object.freeze({
            method: route.method,
            path,
            controller: controllerClass.name,
            handler: route.handler,
          }),
          observer,
        ),
      });
    }
  }

  const routes = [...planned.values()];
  const boundaryPlan = planBoundary(state, routes, boundary);

  return { routes, boundary: boundaryPlan };
}

/**
 * Checks the owned prefixes against the router's existing state and every
 * Strata route below them: the boundary can only answer 404/405 for paths it
 * can match exactly like Nitro does, so unsupported patterns are rejected
 * here. Strata-to-Strata shape ambiguity is checked once in registration
 * planning, regardless of boundary ownership.
 */
function planBoundary(
  state: RouterState | undefined,
  routes: readonly PlannedRoute[],
  request: BoundaryRequest | undefined,
): BoundaryPlan | undefined {
  const prefixes = new Map<string, { head: string; options: string }>();

  for (const entry of state?.boundaries.values() ?? []) {
    prefixes.set(entry.prefix, { head: entry.head, options: entry.options });
  }

  const newPrefixes: string[] = [];

  for (const prefix of request?.prefixes ?? []) {
    const existing = prefixes.get(prefix);

    if (existing) {
      if (existing.head !== request?.head || existing.options !== request.options) {
        throw new StrataAnalogConfigurationError(
          `apiBoundary prefix "${prefix}" is already owned on this router with a different head/options policy.`,
        );
      }
      continue;
    }

    for (const other of prefixes.keys()) {
      if (prefixesOverlap(prefix, other)) {
        throw new StrataAnalogConfigurationError(
          `apiBoundary prefix "${prefix}" overlaps "${other}", already owned on this router; a path may have only one owner.`,
        );
      }
    }

    prefixes.set(prefix, { head: request?.head ?? "derive", options: request?.options ?? "off" });
    newPrefixes.push(prefix);
  }

  if (prefixes.size === 0) {
    return undefined;
  }

  // Every Strata route below an owned prefix, already registered or planned.
  const owned = [
    ...[...(state?.routes.values() ?? [])].map((route) => ({ ...route, planned: false })),
    ...routes.map((route) => ({
      owner: route.owner,
      path: route.path,
      method: route.httpMethod,
      planned: true,
    })),
  ].filter((route) => [...prefixes.keys()].some((prefix) => isUnderPrefix(route.path, prefix)));
  const shapes = new Map<string, { owner: string; path: string }>();

  for (const route of owned) {
    const segments = compilePattern(route.path);

    if (!segments) {
      throw new StrataAnalogConfigurationError(
        `"${route.owner}" (${route.method} ${route.path}) is below an owned API prefix but uses a path ` +
          'the boundary cannot match. Use static and ":param" segments only (no wildcards, ' +
          "partial-segment parameters or repeated parameter names).",
      );
    }

    const shapeKey = `${route.method} ${shapeOf(segments)}`;
    if (!shapes.has(shapeKey)) shapes.set(shapeKey, { owner: route.owner, path: route.path });
  }

  const declared = [
    ...[...(state?.boundaries.values() ?? [])].flatMap((entry) => entry.native),
    ...(request?.native ?? []),
  ];

  for (const native of declared) {
    for (const method of native.methods) {
      const other = shapes.get(`${method} ${shapeOf(native.segments)}`);

      if (other) {
        throw new StrataAnalogConfigurationError(
          `apiBoundary.nativeRoutes declares "${method} ${native.path}", which "${other.owner}" also registers as a Strata route.`,
        );
      }
    }
  }

  return { newPrefixes, request };
}

/**
 * Adds planned routes in order (controllers array order, then route
 * declaration order), recording each one as Strata-owned only after
 * `router.add()` returns. If the router throws, its error propagates and the
 * routes it already accepted stay registered: Strata cannot undo another
 * router's mutation.
 */
function commitRegistration(
  router: NitroRouter,
  plan: { routes: readonly PlannedRoute[]; boundary: BoundaryPlan | undefined },
): void {
  const state: RouterState = routerStates.get(router) ?? {
    routes: new Map(),
    boundaries: new Map(),
  };

  routerStates.set(router, state);

  for (const route of plan.routes) {
    router.add(route.path, route.handler, route.method);

    state.routes.set(route.key, {
      owner: route.owner,
      path: route.path,
      method: route.httpMethod,
      handler: route.handler,
    });

    for (const entry of state.boundaries.values()) {
      if (isUnderPrefix(route.path, entry.prefix))
        addBoundaryRoute(entry, state.routes.get(route.key));
    }
  }

  if (!plan.boundary) return;

  const { request, newPrefixes } = plan.boundary;

  for (const prefix of newPrefixes) {
    const entry: BoundaryEntry = {
      prefix,
      head: request?.head ?? "derive",
      options: request?.options ?? "off",
      routes: [],
      native: [],
    };

    for (const route of state.routes.values()) {
      if (isUnderPrefix(route.path, prefix)) addBoundaryRoute(entry, route);
    }

    state.boundaries.set(prefix, entry);

    const handler = createBoundaryHandler(entry);

    // `/api/**` does not match `/api` itself in Nitro's router, so both are added.
    router.add(prefix, handler, ALL_METHODS);
    router.add(`${prefix}/**`, handler, ALL_METHODS);
  }

  for (const entry of state.boundaries.values()) {
    for (const native of request?.native ?? []) {
      if (isUnderPrefix(native.path, entry.prefix)) entry.native.push(native);
    }
  }
}

function addBoundaryRoute(entry: BoundaryEntry, route: RegisteredRoute | undefined): void {
  const segments = route ? compilePattern(route.path) : undefined;

  if (!route || !segments) return;

  entry.routes = [...entry.routes, { route, segments }].sort((a, b) =>
    compareSpecificity(a.segments, b.segments),
  );
}

/**
 * The fallback Nitro reaches for a request below an owned prefix that no
 * specific route handled: Nitro's router chooses the most specific entry that
 * has a handler for the request method, and this is registered for every
 * method on the least specific entry (`/prefix/**`). Native routes and Strata
 * routes that handle the method are therefore never shadowed.
 */
function createBoundaryHandler(entry: BoundaryEntry): (event: NitroEvent) => Promise<unknown> {
  return async (event) => {
    const method = (event.method ?? event.node?.req?.method ?? "GET").toUpperCase();
    const segments = splitRequestPath(
      event.path ?? event.node?.req?.originalUrl ?? event.node?.req?.url ?? "/",
    );
    const strata = segments
      ? entry.routes.flatMap((candidate) => {
          const params = matchPattern(candidate.segments, segments);

          return params ? [{ ...candidate, params }] : [];
        })
      : [];
    const native = segments
      ? entry.native.filter((candidate) => matchPattern(candidate.segments, segments))
      : [];

    if (strata.length === 0 && native.length === 0) {
      return notFoundResponse();
    }

    // Nitro's router does not backtrack: a request that enters a static branch
    // which cannot complete (`/a/new/x` against `/a/new/y` and `/a/:id/x`)
    // lands here although a Strata route matches it. Serving that route keeps
    // the route table and the response consistent; Nitro never gets here when
    // it would have served a Strata route itself.
    const served =
      strata.find((candidate) => candidate.route.method === method) ??
      (method === "HEAD" && entry.head === "derive"
        ? strata.find((candidate) => candidate.route.method === "GET")
        : undefined);

    if (served) {
      // The matched route handles this request: its parameters, not the fallback's.
      if (event.context) (event.context as { params?: unknown }).params = served.params;

      const result = await served.route.handler(event);

      return method === "HEAD" && served.route.method === "GET" ? headResponse(result) : result;
    }

    const get = strata.find((candidate) => candidate.route.method === "GET");
    const preflight = method === "OPTIONS" && isCorsPreflight(getEventHeaders(event));
    const allowed = new Set<StrataAnalogBoundaryMethod>();

    for (const candidate of strata) allowed.add(candidate.route.method);
    for (const candidate of native) for (const declared of candidate.methods) allowed.add(declared);
    if (get && entry.head === "derive") allowed.add("HEAD");
    if (entry.options === "allow" && !preflight) allowed.add("OPTIONS");

    if (method === "OPTIONS" && entry.options === "allow" && !preflight) {
      return optionsResponse(buildAllow(allowed));
    }

    return methodNotAllowedResponse(buildAllow(allowed));
  };
}

function createRouteHandler(
  controllerClass: ControllerClass,
  handler: ControllerHandler,
  controllerFactory: StrataAnalogControllerFactory,
  guards: readonly StrataAnalogGuard[],
  interceptors: readonly StrataAnalogInterceptor[],
  route: StrataAnalogRouteInfo,
  observer: StrataAnalogRequestObserver | undefined,
): (event: NitroEvent) => Promise<unknown> {
  return async (event) => {
    const tracker = observer ? new InvocationObservation(route, observer) : undefined;
    const request = createStrataAnalogRequest(event);
    const scope = new CleanupScope();
    let result: unknown;
    let denied = false;
    let denial: 401 | 403 | undefined;
    let streaming = false;
    try {
      for (const guard of guards) {
        const decision: unknown = await guard(
          Object.freeze({ request, route, onCleanup: scope.register }),
        );
        if (!isGuardDecision(decision)) {
          throw new StrataAnalogConfigurationError(
            "A Strata Analog guard returned an invalid decision.",
          );
        }
        if (!decision.allow) {
          result = guardDeniedResponse(decision.status);
          denied = true;
          denial = decision.status;
          break;
        }
      }
      if (!denied) {
        tracker?.enterExecution();
        const context: StrataAnalogInterceptorContext = Object.freeze({
          request,
          route,
          onCleanup: scope.register,
        });
        const executeController = async (): Promise<unknown> => {
          const controller = await controllerFactory(
            controllerClass,
            Object.freeze({ request, onCleanup: scope.register }),
          );
          assertControllerInstance(controllerClass, controller);
          return handler.call(controller, request);
        };
        const executeInterceptor = (index: number): Promise<unknown> => {
          const interceptor = interceptors[index];
          if (!interceptor) return executeController();
          let state: "ready" | "running" | "settled" = "ready";
          let downstream: Promise<unknown> | undefined;
          let downstreamSettled = false;
          const next: StrataAnalogNext = () => {
            if (state === "settled") {
              return Promise.reject(
                new StrataAnalogConfigurationError(
                  "An interceptor called next() after it settled.",
                ),
              );
            }
            if (state === "running") {
              return Promise.reject(
                new StrataAnalogConfigurationError(
                  "An interceptor called next() more than once or concurrently.",
                ),
              );
            }
            state = "running";
            downstream = executeInterceptor(index + 1);
            void downstream.then(
              () => (downstreamSettled = true),
              () => (downstreamSettled = true),
            );
            return downstream;
          };
          return (async () => {
            try {
              const value = await interceptor(context, next);
              if (state === "ready") {
                throw new StrataAnalogConfigurationError(
                  "An interceptor completed without calling next().",
                );
              }
              if (!downstreamSettled && downstream) {
                await downstream.catch(() => undefined);
                throw new StrataAnalogConfigurationError(
                  "An interceptor must await downstream execution before settling.",
                );
              }
              return value;
            } finally {
              // A rejected interceptor (for example, Promise.all([next(), next()]))
              // must not let downstream work outlive this request's cleanup scope.
              if (downstream && !downstreamSettled) {
                try {
                  await downstream;
                } catch {
                  // Preserve the interceptor's own failure; downstream is drained
                  // only to keep request-scoped resources alive until it settles.
                }
              }
              state = "settled";
            }
          })();
        };
        result = await executeInterceptor(0);
        // Only the response that leaves the last interceptor owns the scope, so an
        // interceptor that replaces a streamResponse() hands nothing over.
        tracker?.invoked();
        streaming = claimStreamResponse(result, scope, tracker?.streamSettled);
      }
    } catch (error) {
      tracker?.invoked();
      try {
        await scope.close({ failed: true, error });
      } catch (settledError) {
        // CleanupScope rethrows the invocation error unchanged only when every
        // cleanup succeeded. A cleanup failure (including an HTTP error thrown
        // by cleanup code) must remain visible as the route failure.
        if (settledError !== error) {
          tracker?.cleanupFailed();
          throw settledError;
        }
        tracker?.failed(error);
        if (settledError instanceof StrataAnalogInputError) {
          return inputErrorResponse(settledError);
        }
        if (settledError instanceof StrataAnalogHttpError) {
          return applicationErrorResponse(settledError);
        }

        throw settledError;
      }

      throw error;
    }

    if (streaming) return result;

    tracker?.invoked();
    try {
      const settled = await scope.close({ failed: false }, result);
      tracker?.completed(denial);
      return settled;
    } catch (error) {
      tracker?.cleanupFailed();
      throw error;
    }
  };
}

function applicationErrorResponse(error: StrataAnalogHttpError): Response {
  return new Response(JSON.stringify({ error: error.code }), {
    status: error.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isGuardDecision(value: unknown): value is StrataAnalogGuardDecision {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  const allow = Object.getOwnPropertyDescriptor(value, "allow");
  if (keys.length === 1 && keys[0] === "allow") {
    return allow !== undefined && "value" in allow && allow.value === true;
  }
  if (keys.length !== 2 || !keys.includes("allow") || !keys.includes("status")) return false;
  const status = Object.getOwnPropertyDescriptor(value, "status");
  return (
    allow !== undefined &&
    "value" in allow &&
    allow.value === false &&
    status !== undefined &&
    "value" in status &&
    (status.value === 401 || status.value === 403)
  );
}

function guardDeniedResponse(status: 401 | 403): Response {
  return new Response(JSON.stringify({ error: status === 401 ? "unauthorized" : "forbidden" }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function describeController(value: unknown): string {
  return typeof value === "function" ? `"${value.name}"` : describeValue(value);
}

/**
 * Finds a route's handler on the controller's prototype chain, so it can be
 * validated at registration without instantiating the controller.
 *
 * Only a data property holding a function counts as a handler: an accessor is
 * rejected rather than invoked, since calling a getter on the prototype would
 * run instance code without an instance. Instance fields and static methods
 * are not handlers (HTTP route decorators only decorate methods).
 */
function resolveRouteHandler(
  controllerClass: ControllerClass,
  route: RouteDefinition,
): ControllerHandler {
  for (
    let owner: object | null = controllerClass.prototype as object;
    owner !== null && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner) as object | null
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, route.handler);

    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor && typeof descriptor.value === "function") {
      return descriptor.value as ControllerHandler;
    }

    break;
  }

  throw new StrataAnalogConfigurationError(
    `"${controllerClass.name}.${route.handler}" is not callable. Strata route handlers must be methods.`,
  );
}

function assertControllerInstance(
  controllerClass: ControllerClass,
  controller: unknown,
): asserts controller is object {
  if (!(controller instanceof controllerClass)) {
    throw new StrataAnalogConfigurationError(
      `The controllerFactory returned ${describeValue(controller)} for "${controllerClass.name}". ` +
        `It must return an instance of "${controllerClass.name}".`,
    );
  }
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "object") {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;

    return typeof name === "string" && name ? `an instance of "${name}"` : "an object";
  }

  return `a ${typeof value}`;
}

interface NitroEvent {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Headers;
  readonly context?: Record<string, unknown> & { params?: Record<string, unknown> };
  readonly web?: {
    readonly request?: Request;
    readonly url?: URL;
  };
  readonly node?: {
    readonly req?: NitroNodeRequest;
  };
}

interface NitroNodeRequest extends AsyncIterable<Uint8Array | string> {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly originalUrl?: string;
  readonly headers?: Record<string, string | readonly string[] | undefined>;
  /**
   * A payload the runtime attached instead of streaming it. Nitro on
   * Cloudflare (workerd) calls H3 with a mock Node request whose stream is not
   * iterable and whose body is set here; H3 v1's own `readRawBody` reads these
   * first, too.
   */
  readonly rawBody?: unknown;
  readonly body?: unknown;
}

function createStrataAnalogRequest(event: NitroEvent): StrataAnalogRequest {
  const url = getEventUrl(event);
  const headers = getEventHeaders(event);
  let textBody: Promise<string> | undefined;
  let bodyReader: "raw" | "validated-json" | "validated-form" | undefined;
  let validatedText: Promise<string> | undefined;

  const readText = async (): Promise<string> => {
    bodyReader ??= "raw";
    if (bodyReader === "raw") {
      textBody ??= readEventText(event);
    } else {
      validatedText ??= readEventTextBounded(event, MAX_VALIDATED_JSON_BYTES);
      textBody ??= validatedText;
    }

    return textBody;
  };

  const readJson = async <T = unknown>(): Promise<T> => {
    const text = await readText();

    return (text.length === 0 ? undefined : JSON.parse(text)) as T;
  };

  const readBody = async (): Promise<unknown> => {
    const contentType = headers.get("content-type") ?? "";
    const text = await readText();

    if (text.length === 0) {
      return undefined;
    }

    if (contentType.includes("application/json")) {
      return JSON.parse(text) as unknown;
    }

    if (contentType.includes("application/x-www-form-urlencoded")) {
      return parseQuery(new URLSearchParams(text));
    }

    return text;
  };

  const validateParams = <Schema extends StandardSchemaV1>(schema: Schema) =>
    validateSchema(schema, Object.freeze({ ...getEventParams(event) }), "params");
  const validateQuery = <Schema extends StandardSchemaV1>(schema: Schema) =>
    validateSchema(schema, Object.freeze(parseQuery(url.searchParams)), "query");
  const validateHeaders = <Schema extends StandardSchemaV1>(schema: Schema) =>
    validateSchema(schema, snapshotHeaders(headers), "headers");
  const readValidatedJson = async <Schema extends StandardSchemaV1>(schema: Schema) => {
    if (bodyReader === "raw") {
      throw new StrataAnalogConfigurationError(
        "readValidatedJson() must be the first body reader on a request so its byte limit can be enforced.",
      );
    }
    if (bodyReader === "validated-form") {
      throw new StrataAnalogConfigurationError(
        "readValidatedJson() cannot follow readValidatedForm() on the same request.",
      );
    }
    bodyReader = "validated-json";

    const contentType = headers.get("content-type") ?? "";
    if (!isJsonMediaType(contentType)) throw new StrataAnalogInputError("body", 415);
    if (hasUnsupportedCharset(contentType)) throw new StrataAnalogInputError("body", 415);
    validatedText ??= readEventTextBounded(event, MAX_VALIDATED_JSON_BYTES);
    textBody ??= validatedText;
    const text = await validatedText;
    let value: unknown;
    try {
      value = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new StrataAnalogInputError("body", 400);
    }
    return validateSchema(schema, value, "body");
  };
  const readValidatedForm = async <Schema extends StandardSchemaV1>(schema: Schema) => {
    if (bodyReader === "raw") {
      throw new StrataAnalogConfigurationError(
        "readValidatedForm() must be the first body reader on a request so its byte limit can be enforced.",
      );
    }
    if (bodyReader === "validated-json") {
      throw new StrataAnalogConfigurationError(
        "readValidatedForm() cannot follow readValidatedJson() on the same request.",
      );
    }
    bodyReader = "validated-form";

    const contentType = headers.get("content-type") ?? "";
    if (!isFormMediaType(contentType) || hasUnsupportedFormCharset(contentType)) {
      throw new StrataAnalogInputError("body", 415);
    }
    validatedText ??= readEventTextBounded(event, MAX_VALIDATED_JSON_BYTES);
    textBody ??= validatedText;
    const text = await validatedText;
    const value = parseValidatedForm(text);
    return validateSchema(schema, value, "body");
  };

  return Object.freeze({
    method: event.method ?? event.node?.req?.method ?? "GET",
    path: url.pathname,
    url,
    headers,
    params: Object.freeze(getEventParams(event)),
    query: Object.freeze(parseQuery(url.searchParams)),
    context: Object.freeze({ ...(event.context ?? {}) }),
    readBody,
    readText,
    readJson,
    validateParams,
    validateQuery,
    validateHeaders,
    readValidatedJson,
    readValidatedForm,
  });
}

function getEventUrl(event: NitroEvent): URL {
  if (event.web?.url) {
    return new URL(event.web.url);
  }

  if (event.web?.request) {
    return new URL(event.web.request.url);
  }

  return new URL(
    event.path ?? event.node?.req?.originalUrl ?? event.node?.req?.url ?? "/",
    "http://localhost",
  );
}

function getEventHeaders(event: NitroEvent): Headers {
  if (event.headers) {
    return new Headers(event.headers);
  }

  const headers = new Headers();

  for (const [key, value] of Object.entries(event.node?.req?.headers ?? {})) {
    if (isStringArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  return headers;
}

function snapshotHeaders(headers: Headers): StrataAnalogHeaders {
  const snapshot: Record<string, string> = {};

  for (const [key, value] of headers) {
    const previous = Object.hasOwn(snapshot, key) ? snapshot[key] : undefined;
    setOwn(snapshot, key, previous === undefined ? value : `${previous}, ${value}`);
  }

  return Object.freeze(snapshot);
}

function getEventParams(event: NitroEvent): Record<string, string> {
  const params: Record<string, string> = {};

  for (const [key, value] of Object.entries(event.context?.params ?? {})) {
    if (typeof value === "string") {
      setOwn(params, key, value);
    }
  }

  return params;
}

function parseQuery(searchParams: URLSearchParams): Record<string, StrataAnalogQueryValue> {
  const query: Record<string, StrataAnalogQueryValue> = {};

  for (const [key, value] of searchParams) {
    const previous = Object.hasOwn(query, key) ? query[key] : undefined;

    if (previous === undefined) {
      setOwn(query, key, value);
    } else if (isStringArray(previous)) {
      setOwn(query, key, [...previous, value]);
    } else {
      setOwn(query, key, [previous, value]);
    }
  }

  return query;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function readEventText(event: NitroEvent): Promise<string> {
  const request = event.web?.request;

  if (request) {
    return request.clone().text();
  }

  const requestBody = event.node?.req;

  if (!requestBody) {
    return "";
  }

  const attached = requestBody.rawBody ?? requestBody.body;

  if (attached !== undefined && attached !== null) {
    return readAttachedBody(attached);
  }

  const chunks: string[] = [];

  for await (const chunk of requestBody) {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  }

  return chunks.join("");
}

const MAX_VALIDATED_JSON_BYTES = 1024 * 1024;
const MAX_VALIDATED_FORM_FIELDS = 10_000;

async function validateSchema<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
  source: StrataAnalogInputError["source"],
): Promise<StandardSchemaV1.InferOutput<Schema>> {
  const schemaValue: unknown = schema;
  let standard: object;
  let validate: (...args: unknown[]) => unknown;
  try {
    const metadata =
      schemaValue !== null && typeof schemaValue === "object"
        ? (Reflect.get(schemaValue, "~standard") as unknown)
        : undefined;
    if (
      metadata === null ||
      typeof metadata !== "object" ||
      Reflect.get(metadata, "version") !== 1 ||
      typeof Reflect.get(metadata, "vendor") !== "string" ||
      typeof Reflect.get(metadata, "validate") !== "function"
    ) {
      throw new StrataAnalogConfigurationError(
        "A validation schema must implement Standard Schema v1.",
      );
    }
    standard = metadata;
    validate = Reflect.get(metadata, "validate") as (...args: unknown[]) => unknown;
  } catch (error) {
    if (error instanceof StrataAnalogConfigurationError) throw error;
    throw new StrataAnalogConfigurationError(
      "Reading Standard Schema metadata threw; schemas must expose readable v1 metadata.",
    );
  }
  const result: unknown = await Reflect.apply(validate, standard, [value]);
  if (result === null || typeof result !== "object") {
    throw new StrataAnalogConfigurationError(
      "A Standard Schema validator returned a malformed result.",
    );
  }
  let issues: unknown;
  let hasValue: boolean;
  let output: unknown;
  try {
    issues = Reflect.get(result, "issues") as unknown;
    hasValue = Reflect.has(result, "value");
    output = Reflect.get(result, "value");
    if (
      issues &&
      (!Array.isArray(issues) ||
        issues.some(
          (issue: unknown) =>
            issue === null ||
            typeof issue !== "object" ||
            typeof Reflect.get(issue, "message") !== "string",
        ))
    ) {
      throw new StrataAnalogConfigurationError(
        "A Standard Schema validator returned malformed issues.",
      );
    }
  } catch (error) {
    if (error instanceof StrataAnalogConfigurationError) throw error;
    throw new StrataAnalogConfigurationError(
      "Reading a Standard Schema result threw; validation results must be readable.",
    );
  }
  if (issues) throw new StrataAnalogInputError(source, 400);
  if (!hasValue) {
    throw new StrataAnalogConfigurationError(
      "A Standard Schema validator returned a malformed result.",
    );
  }
  return output;
}

function isJsonMediaType(contentType: string): boolean {
  const [mediaType] = contentType.split(";", 1);
  const normalized = mediaType?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/json" ||
    /^application\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/.test(normalized)
  );
}

function isFormMediaType(contentType: string): boolean {
  const [mediaType] = contentType.split(";", 1);
  return (mediaType?.trim().toLowerCase() ?? "") === "application/x-www-form-urlencoded";
}

function hasUnsupportedFormCharset(contentType: string): boolean {
  const parameters = contentType.split(";").slice(1);
  let charsetSeen = false;
  for (const parameter of parameters) {
    const trimmed = parameter.trim();
    if (!/^charset(?:\s*=|\s*$)/i.test(trimmed)) continue;
    if (charsetSeen) return true;
    charsetSeen = true;
    const match = /^charset\s*=\s*(?:"([^"]+)"|([!#$%&'*+.^_`|~0-9a-z-]+))$/i.exec(trimmed);
    const value = (match?.[1] ?? match?.[2])?.toLowerCase();
    if (value !== "utf-8" && value !== "utf8") return true;
  }
  return false;
}

function parseValidatedForm(text: string): Record<string, StrataAnalogQueryValue> {
  let fieldCount = 0;
  for (let start = 0; start < text.length;) {
    const separator = text.indexOf("&", start);
    const end = separator === -1 ? text.length : separator;
    if (end > start) fieldCount += 1;
    if (fieldCount > MAX_VALIDATED_FORM_FIELDS) throw new StrataAnalogInputError("body", 413);
    start = end + 1;
  }

  // Check encoded components before URLSearchParams: its forgiving decoder
  // replaces malformed escapes and invalid UTF-8 with U+FFFD.
  for (let start = 0; start < text.length;) {
    const fieldEnd = text.indexOf("&", start);
    const end = fieldEnd === -1 ? text.length : fieldEnd;
    if (end === start) {
      start = end + 1;
      continue;
    }
    const separator = text.indexOf("=", start);
    const valueStart = separator === -1 || separator >= end ? end : separator + 1;
    try {
      decodeURIComponent(
        text
          .slice(start, separator === -1 || separator >= end ? end : separator)
          .replaceAll("+", "%20"),
      );
      decodeURIComponent(text.slice(valueStart, end).replaceAll("+", "%20"));
    } catch {
      throw new StrataAnalogInputError("body", 400);
    }
    start = end + 1;
  }

  return parseQuery(new URLSearchParams(text));
}

function hasUnsupportedCharset(contentType: string): boolean {
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const value = (charset?.[1] ?? charset?.[2])?.toLowerCase();
  return value !== undefined && value !== "utf-8" && value !== "utf8";
}

async function readEventTextBounded(event: NitroEvent, limit: number): Promise<string> {
  const request = event.web?.request;
  if (request) return decodeBytes(await readStreamBounded(request.clone().body, limit));
  const nodeRequest = event.node?.req;
  if (!nodeRequest) return "";
  const attached = nodeRequest.rawBody ?? nodeRequest.body;
  if (attached !== undefined && attached !== null) {
    if (typeof attached === "string") {
      if (attached.length > limit) throw new StrataAnalogInputError("body", 413);
      return decodeBytes(new TextEncoder().encode(attached), limit);
    }
    if (attached instanceof Uint8Array) return decodeBytes(attached, limit);
    if (attached instanceof ReadableStream)
      return decodeBytes(await readStreamBounded(attached, limit));
    throw new TypeError("Unsupported request body representation.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of nodeRequest) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > limit) throw new StrataAnalogInputError("body", 413);
    chunks.push(bytes);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeBytes(combined);
}

async function readStreamBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel();
        throw new StrataAnalogInputError("body", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeBytes(bytes: Uint8Array, limit?: number): string {
  if (limit !== undefined && bytes.byteLength > limit)
    throw new StrataAnalogInputError("body", 413);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrataAnalogInputError("body", 400);
  }
}

function inputErrorResponse(error: StrataAnalogInputError): Response {
  const code =
    error.status === 413
      ? "payload_too_large"
      : error.status === 415
        ? "unsupported_media_type"
        : "invalid_request";
  return new Response(JSON.stringify({ error: code, source: error.source }), {
    status: error.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readAttachedBody(body: unknown): Promise<string> {
  if (typeof body === "string") {
    return body;
  }

  // Includes Node's Buffer.
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (body instanceof ReadableStream) {
    return new Response(body).text();
  }

  throw new TypeError(`Unsupported request body: ${describeValue(body)}.`);
}
