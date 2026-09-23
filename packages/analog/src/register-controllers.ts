import { getControllerDefinition } from "@strata/core";
import type { HttpMethod, RouteDefinition } from "@strata/core";

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
 * `@strata/core` types controller classes as abstract constructors (it only
 * ever reads their metadata), but this adapter must be able to instantiate
 * them, so it narrows the requirement to a concrete, no-argument
 * constructor.
 */
export type ControllerClass = new () => object;

/**
 * Strata's HTTP method names → the lowercase names Nitro's router expects.
 * `satisfies Record<HttpMethod, …>` makes this a compile error, not a silent
 * mis-registration, the day `@strata/core` adds a method.
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
 * - Analog 2 runs on Nitro 2, which runs on H3 **v1**. `@strata/analog`
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
 * 2. creates a single instance of the controller;
 * 3. registers each `@Get()` route on `router`, joining the controller path
 *    and route path into the final route path;
 * 4. wires each route to invoke the matching controller method with a
 *    `StrataAnalogRequest` argument and return its result directly to
 *    Nitro/H3, which serializes it natively (objects and arrays become JSON).
 *
 * Controller lifecycle (provisional): Strata has no dependency injection or
 * request-scoped lifecycle yet. This function instantiates each controller
 * exactly once, with `new ControllerClass()`, at registration time, and
 * reuses that single instance for every request. This is a deliberately
 * minimal placeholder — not a stable API — until a real controller
 * lifecycle/DI design lands in a later iteration.
 *
 * Request input boundary (provisional): controller methods may accept one
 * `StrataAnalogRequest` argument. It contains route params, query values,
 * headers, method, URL/path, a shallow context snapshot, and lazy body readers
 * without exposing Nitro's H3 v1 event type or requiring a dependency on H3.
 *
 * Registration validates eagerly: a class without `@Controller()` metadata,
 * or a route whose handler isn't a callable method, throws a
 * {@link StrataAnalogConfigurationError} immediately, instead of failing on
 * the first matching request.
 *
 * Strata does not replace Nitro or Analog — this only adds routes to the
 * router you pass in. Native Analog routes (`src/server/routes/**`) keep
 * working exactly as before.
 */
export function registerControllers<Router extends NitroRouter>(
  router: Router,
  controllers: readonly ControllerClass[],
): Router {
  for (const controllerClass of controllers) {
    registerController(router, controllerClass);
  }

  return router;
}

function registerController(router: NitroRouter, controllerClass: ControllerClass): void {
  const definition = getControllerDefinition(controllerClass);

  if (!definition) {
    throw new StrataAnalogConfigurationError(
      `"${controllerClass.name}" is not a Strata controller. Did you forget to add @Controller()?`,
    );
  }

  const instance = new controllerClass();

  for (const route of definition.routes) {
    registerRoute(router, controllerClass, instance, definition.path, route);
  }
}

function registerRoute(
  router: NitroRouter,
  controllerClass: ControllerClass,
  instance: object,
  controllerPath: string,
  route: RouteDefinition,
): void {
  const handler = (instance as Record<string, unknown>)[route.handler];

  if (typeof handler !== "function") {
    throw new StrataAnalogConfigurationError(
      `"${controllerClass.name}.${route.handler}" is not callable. @Get() route handlers must be methods.`,
    );
  }

  const path = buildRoutePath(controllerPath, route.path);

  router.add(
    path,
    (event) => handler.call(instance, createStrataAnalogRequest(event)) as unknown,
    ROUTER_METHOD[route.method],
  );
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
