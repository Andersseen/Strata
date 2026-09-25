import { getControllerDefinition } from "@strata-sc/core";
import type { HttpMethod, RouteDefinition } from "@strata-sc/core";

import { CleanupScope } from "./cleanup-scope.js";
import type { StrataAnalogCleanup } from "./cleanup-scope.js";
import { StrataAnalogConfigurationError } from "./errors.js";
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
}

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
}

type ControllerHandler = (this: object, request: StrataAnalogRequest) => unknown;

const defaultControllerFactory: StrataAnalogControllerFactory = (controller) => new controller();

/**
 * Strata's HTTP method names → the lowercase names Nitro's router expects.
 * `satisfies Record<HttpMethod, …>` makes this a compile error, not a silent
 * mis-registration, the day `@strata-sc/core` adds a method.
 */
const ROUTER_METHOD = { GET: "get" } as const satisfies Record<HttpMethod, Lowercase<HttpMethod>>;

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
 * 3. registers each `@Get()` route on `router`, joining the controller path
 *    and route path into the final route path;
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
 * Registration validates eagerly: a class without `@Controller()` metadata,
 * a route whose handler isn't a method on the controller's prototype chain, or
 * a `controllerFactory` that isn't a function throws a
 * {@link StrataAnalogConfigurationError} immediately, instead of failing on
 * the first matching request. A factory that returns something other than an
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
  const controllerFactory = options.controllerFactory ?? defaultControllerFactory;

  if (typeof controllerFactory !== "function") {
    throw new StrataAnalogConfigurationError(
      "registerControllers() option `controllerFactory` must be a function.",
    );
  }

  for (const controllerClass of controllers) {
    registerController(router, controllerClass, controllerFactory);
  }

  return router;
}

function registerController(
  router: NitroRouter,
  controllerClass: ControllerClass,
  controllerFactory: StrataAnalogControllerFactory,
): void {
  const definition = getControllerDefinition(controllerClass);

  if (!definition) {
    throw new StrataAnalogConfigurationError(
      `"${controllerClass.name}" is not a Strata controller. Did you forget to add @Controller()?`,
    );
  }

  for (const route of definition.routes) {
    const handler = resolveRouteHandler(controllerClass, route);
    const path = buildRoutePath(definition.path, route.path);

    router.add(
      path,
      async (event) => {
        const request = createStrataAnalogRequest(event);
        const scope = new CleanupScope();
        let result: unknown;

        try {
          const controller = await controllerFactory(
            controllerClass,
            Object.freeze({ request, onCleanup: scope.register }),
          );

          assertControllerInstance(controllerClass, controller);

          result = await handler.call(controller, request);
        } catch (error) {
          return scope.close({ failed: true, error });
        }

        return scope.close({ failed: false }, result);
      },
      ROUTER_METHOD[route.method],
    );
  }
}

/**
 * Finds a route's handler on the controller's prototype chain, so it can be
 * validated at registration without instantiating the controller.
 *
 * Only a data property holding a function counts as a handler: an accessor is
 * rejected rather than invoked, since calling a getter on the prototype would
 * run instance code without an instance. Instance fields and static methods
 * are not handlers (`@Get()` only decorates methods).
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
    `"${controllerClass.name}.${route.handler}" is not callable. @Get() route handlers must be methods.`,
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
}

function createStrataAnalogRequest(event: NitroEvent): StrataAnalogRequest {
  const url = getEventUrl(event);
  const headers = getEventHeaders(event);
  let textBody: Promise<string> | undefined;

  const readText = async (): Promise<string> => {
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
      params[key] = value;
    }
  }

  return params;
}

function parseQuery(searchParams: URLSearchParams): Record<string, StrataAnalogQueryValue> {
  const query: Record<string, StrataAnalogQueryValue> = {};

  for (const [key, value] of searchParams) {
    const previous = query[key];

    if (previous === undefined) {
      query[key] = value;
    } else if (isStringArray(previous)) {
      query[key] = [...previous, value];
    } else {
      query[key] = [previous, value];
    }
  }

  return query;
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

  const chunks: string[] = [];

  for await (const chunk of requestBody) {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
  }

  return chunks.join("");
}
