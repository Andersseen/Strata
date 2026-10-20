import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getControllerDefinition } from "@strata-sc/core";
import type { HttpMethod, RouteDefinition } from "@strata-sc/core";

import { CleanupScope } from "./cleanup-scope.js";
import type { StrataAnalogCleanup } from "./cleanup-scope.js";
import { StrataAnalogConfigurationError } from "./errors.js";
import { StrataAnalogInputError } from "./input-error.js";
import { buildRoutePath } from "./utils/build-route-path.js";

export type StrataAnalogQueryValue = string | readonly string[];

export type StrataAnalogQuery = Readonly<Record<string, StrataAnalogQueryValue>>;

export type StrataAnalogParams = Readonly<Record<string, string>>;

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
  readValidatedJson: <Schema extends StandardSchemaV1>(
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
   * does not wait for a streamed response body to be consumed.
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

  const plan = planRegistration(
    router,
    controllers,
    controllerFactory,
    guardSnapshot,
    interceptorSnapshot,
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
  readonly method: RouterMethod;
  readonly handler: (event: NitroEvent) => unknown;
}

/**
 * The Strata routes each router already owns (route key → owner), so a later
 * `registerControllers()` call on the same router cannot register a route
 * twice. Only registration diagnostics are kept; a `WeakMap` never retains a
 * router, and nothing is attached to it.
 *
 * It covers Strata registrations only: routes added to the router by Nitro,
 * Analog or anyone else are not visible here.
 */
const registeredRoutes = new WeakMap<NitroRouter, Map<RouteKey, string>>();

/**
 * Validates the whole batch — every controller, handler and route key —
 * without touching the router or the registry, so a configuration error
 * leaves both exactly as they were.
 */
function planRegistration(
  router: NitroRouter,
  controllers: readonly ControllerClass[],
  controllerFactory: StrataAnalogControllerFactory,
  guards: readonly StrataAnalogGuard[],
  interceptors: readonly StrataAnalogInterceptor[],
): PlannedRoute[] {
  const registered = registeredRoutes.get(router);
  const planned = new Map<RouteKey, PlannedRoute>();

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
      const registeredOwner = registered?.get(key);
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

      planned.set(key, {
        key,
        owner,
        path,
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
        ),
      });
    }
  }

  return [...planned.values()];
}

/**
 * Adds planned routes in order (controllers array order, then route
 * declaration order), recording each one as Strata-owned only after
 * `router.add()` returns. If the router throws, its error propagates and the
 * routes it already accepted stay registered: Strata cannot undo another
 * router's mutation.
 */
function commitRegistration(router: NitroRouter, plan: readonly PlannedRoute[]): void {
  for (const route of plan) {
    router.add(route.path, route.handler, route.method);

    let registered = registeredRoutes.get(router);

    if (!registered) {
      registered = new Map();
      registeredRoutes.set(router, registered);
    }

    registered.set(route.key, route.owner);
  }
}

function createRouteHandler(
  controllerClass: ControllerClass,
  handler: ControllerHandler,
  controllerFactory: StrataAnalogControllerFactory,
  guards: readonly StrataAnalogGuard[],
  interceptors: readonly StrataAnalogInterceptor[],
  route: StrataAnalogRouteInfo,
): (event: NitroEvent) => Promise<unknown> {
  return async (event) => {
    const request = createStrataAnalogRequest(event);
    const scope = new CleanupScope();
    let result: unknown;
    let denied = false;
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
          break;
        }
      }
      if (!denied) {
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
      }
    } catch (error) {
      try {
        await scope.close({ failed: true, error });
      } catch (settledError) {
        if (settledError instanceof StrataAnalogInputError) {
          return inputErrorResponse(settledError);
        }

        throw settledError;
      }

      throw error;
    }

    return scope.close({ failed: false }, result);
  };
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
  let rawReadStarted = false;
  let validatedText: Promise<string> | undefined;

  const readText = async (): Promise<string> => {
    rawReadStarted = true;
    textBody ??= readEventText(event);

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
  const readValidatedJson = async <Schema extends StandardSchemaV1>(schema: Schema) => {
    if (rawReadStarted) {
      throw new StrataAnalogConfigurationError(
        "readValidatedJson() must be the first body reader on a request so its byte limit can be enforced.",
      );
    }

    const contentType = headers.get("content-type") ?? "";
    if (!isJsonMediaType(contentType)) throw new StrataAnalogInputError("body", 415);
    if (hasUnsupportedCharset(contentType)) throw new StrataAnalogInputError("body", 415);
    validatedText ??= readEventTextBounded(event, MAX_VALIDATED_JSON_BYTES);
    const text = await validatedText;
    let value: unknown;
    try {
      value = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      throw new StrataAnalogInputError("body", 400);
    }
    textBody ??= Promise.resolve(text);
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
    readValidatedJson,
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

async function validateSchema<Schema extends StandardSchemaV1>(
  schema: Schema,
  value: unknown,
  source: "params" | "query" | "body",
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
