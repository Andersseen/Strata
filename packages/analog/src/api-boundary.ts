import type { HttpMethod } from "@strata-sc/core";

import { StrataAnalogConfigurationError } from "./errors.js";

/** Methods a native Nitro route may declare to the boundary. */
export type StrataAnalogBoundaryMethod = HttpMethod | "HEAD" | "OPTIONS";

/**
 * A route the application registers natively on Nitro (for example
 * `src/server/routes/api/health.get.ts`) inside an owned API prefix.
 *
 * Declaring it is optional shared metadata: it lets the boundary answer a
 * wrong-method request on that path with an accurate 405 and `Allow`, instead
 * of a 404 for a path it does not know. The boundary never serves the route.
 */
export interface StrataAnalogNativeRoute {
  /** Static and `:param` segments only, for example `/api/health` or `/api/files/:id`. */
  readonly path: string;
  /** The methods the native route handles itself. */
  readonly methods: readonly StrataAnalogBoundaryMethod[];
}

/** Opt-in ownership of one or more API path prefixes. */
export interface StrataAnalogApiBoundaryOptions {
  /**
   * Absolute prefixes the boundary owns, for example `["/api"]`. Each is one
   * or more static segments; `/` is rejected, so the site itself is never
   * owned. Prefixes in one router must not overlap.
   */
  readonly prefixes: readonly string[];
  /** Native Nitro routes under the prefixes, declared for accurate 405 and `Allow`. */
  readonly nativeRoutes?: readonly StrataAnalogNativeRoute[];
  /**
   * `"derive"` (default): `HEAD` on a path with a Strata `GET` route runs that
   * route's full pipeline once and returns its status and headers without a
   * body. `"off"`: `HEAD` is answered like any other unsupported method.
   */
  readonly head?: "derive" | "off";
  /**
   * `"off"` (default): `OPTIONS` is answered like any other unsupported
   * method. `"allow"`: a plain `OPTIONS` request on a known path returns
   * `204` with `Allow`. CORS preflights are never answered either way.
   */
  readonly options?: "allow" | "off";
}

/** The validated, normalized form of {@link StrataAnalogApiBoundaryOptions}. */
export interface BoundaryRequest {
  readonly prefixes: readonly string[];
  readonly native: readonly NativeEntry[];
  readonly head: "derive" | "off";
  readonly options: "allow" | "off";
}

export interface NativeEntry {
  readonly path: string;
  readonly segments: readonly Segment[];
  readonly methods: readonly StrataAnalogBoundaryMethod[];
}

/** A static segment, or a `:param` placeholder. */
export type Segment = { readonly param: string } | string;

/** Stable method order for `Allow`. */
const METHOD_ORDER: readonly StrataAnalogBoundaryMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
];

const STATIC_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

export function isBoundaryMethod(value: unknown): value is StrataAnalogBoundaryMethod {
  return typeof value === "string" && (METHOD_ORDER as readonly string[]).includes(value);
}

/**
 * Normalizes an owned prefix: one or more static segments, a leading `/`, no
 * trailing `/`. Anything else is a configuration error rather than a guess.
 */
export function normalizePrefix(value: unknown): string {
  if (typeof value !== "string") {
    throw new StrataAnalogConfigurationError(
      'apiBoundary.prefixes must contain only strings, each an absolute path prefix such as "/api".',
    );
  }

  const trimmed = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = trimmed.startsWith("/") ? trimmed.slice(1).split("/") : [];

  if (segments.length === 0 || !segments.every((segment) => STATIC_SEGMENT.test(segment))) {
    throw new StrataAnalogConfigurationError(
      `Invalid apiBoundary prefix ${JSON.stringify(value)}. A prefix must be an absolute path of ` +
        'static segments (letters, digits, ".", "_", "~", "-"), for example "/api"; ' +
        '"/" would own the whole site and wildcards or parameters are not allowed.',
    );
  }

  return `/${segments.join("/")}`;
}

/** `true` when `path` is `prefix` or lies below it, on a segment boundary. */
export function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether two normalized prefixes own overlapping namespaces. */
export function prefixesOverlap(a: string, b: string): boolean {
  return isUnderPrefix(a, b) || isUnderPrefix(b, a);
}

/**
 * Compiles a route pattern the boundary can match: static segments and
 * `:param` segments. Wildcards, partial-segment params, empty or duplicated
 * param names are not supported, because the boundary must never guess how
 * Nitro would match them. Returns `undefined` for those.
 */
export function compilePattern(path: string): readonly Segment[] | undefined {
  if (!path.startsWith("/") || path === "/") return undefined;

  const segments: Segment[] = [];
  const names = new Set<string>();

  for (const raw of path.slice(1).split("/")) {
    const param = PARAM_SEGMENT.exec(raw);

    if (param?.[1] !== undefined) {
      if (names.has(param[1])) return undefined;
      names.add(param[1]);
      segments.push({ param: param[1] });
    } else if (STATIC_SEGMENT.test(raw)) {
      segments.push(raw);
    } else {
      return undefined;
    }
  }

  return segments;
}

/** Identity of a pattern's shape: parameter names do not distinguish routes. */
export function shapeOf(segments: readonly Segment[]): string {
  return segments.map((segment) => (typeof segment === "string" ? segment : ":")).join("/");
}

/**
 * Splits the router path (`event.path` without its query) into segments the
 * way Nitro's router sees it: one trailing `/` is ignored, every other empty
 * segment makes the path unmatchable. The router already decoded the path, so
 * it is never decoded again here.
 */
export function splitRequestPath(rawPath: string): readonly string[] | undefined {
  const query = rawPath.search(/[?#]/);
  const path = query === -1 ? rawPath : rawPath.slice(0, query);

  if (!path.startsWith("/")) return undefined;

  const parts = path.slice(1).split("/");

  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();

  return parts.some((part) => part === "") ? undefined : parts;
}

export function matchPattern(
  pattern: readonly Segment[],
  requestSegments: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== requestSegments.length) return undefined;

  const params: Record<string, string> = {};

  for (const [index, segment] of pattern.entries()) {
    const value = requestSegments[index];

    if (value === undefined) return undefined;
    if (typeof segment === "string") {
      if (segment !== value) return undefined;
    } else {
      Object.defineProperty(params, segment.param, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return params;
}

/**
 * Orders more specific patterns first: at the first position where one is
 * static and the other a parameter, the static one wins, as in Nitro's router.
 */
export function compareSpecificity(a: readonly Segment[], b: readonly Segment[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = typeof a[index] === "string";
    const right = typeof b[index] === "string";

    if (left !== right) return left ? -1 : 1;
  }

  return 0;
}

export function buildAllow(methods: ReadonlySet<StrataAnalogBoundaryMethod>): string {
  return METHOD_ORDER.filter((method) => methods.has(method)).join(", ");
}

/** A CORS preflight: `OPTIONS` carrying `Origin` and `Access-Control-Request-Method`. */
export function isCorsPreflight(headers: Headers): boolean {
  return headers.has("origin") && headers.has("access-control-request-method");
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

export function notFoundResponse(): Response {
  return new Response('{"error":"not_found"}', { status: 404, headers: JSON_HEADERS });
}

export function methodNotAllowedResponse(allow: string): Response {
  return new Response('{"error":"method_not_allowed"}', {
    status: 405,
    headers: { ...JSON_HEADERS, allow },
  });
}

export function optionsResponse(allow: string): Response {
  return new Response(null, { status: 204, headers: { allow, "cache-control": "no-store" } });
}

/**
 * The `HEAD` view of a `GET` route's result: its status and headers, never a
 * body. A `Response` body is released without being read, so a stream is not
 * consumed. A plain value gets the content type H3 would give it for JSON and
 * strings; other values carry no content type.
 */
export function headResponse(result: unknown): Response {
  if (result instanceof Response) {
    const { status, statusText, headers, body } = result;

    void body?.cancel().catch(() => undefined);

    return new Response(null, { status, statusText, headers });
  }

  if (result === undefined || result === null) return new Response(null, { status: 204 });

  if (typeof result === "string") {
    return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
  }

  if (typeof result === "object" || typeof result === "number" || typeof result === "boolean") {
    return new Response(null, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return new Response(null, { status: 200 });
}

const BOUNDARY_KEYS = new Set(["prefixes", "nativeRoutes", "head", "options"]);
const NATIVE_KEYS = new Set(["path", "methods"]);

interface BoundaryInput {
  readonly prefixes?: unknown;
  readonly nativeRoutes?: unknown;
  readonly head?: unknown;
  readonly options?: unknown;
}

interface NativeInput {
  readonly path?: unknown;
  readonly methods?: unknown;
}

function isPlainRecord<T extends object>(value: unknown): value is T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(value: object, known: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new StrataAnalogConfigurationError(`Unknown ${where} option ${JSON.stringify(key)}.`);
    }
  }
}

/**
 * Validates `registerControllers()`'s `apiBoundary` option as a whole and
 * returns a normalized snapshot, so nothing the caller mutates later changes
 * what the router enforces.
 */
export function parseApiBoundary(value: unknown): BoundaryRequest {
  if (!isPlainRecord<BoundaryInput>(value)) {
    throw new StrataAnalogConfigurationError(
      "registerControllers() option `apiBoundary` must be an object.",
    );
  }
  rejectUnknownKeys(value, BOUNDARY_KEYS, "apiBoundary");

  if (!Array.isArray(value.prefixes) || value.prefixes.length === 0) {
    throw new StrataAnalogConfigurationError(
      'apiBoundary.prefixes must be a non-empty array of path prefixes such as ["/api"].',
    );
  }

  const prefixes: string[] = [];
  for (const raw of value.prefixes as readonly unknown[]) {
    const prefix = normalizePrefix(raw);
    for (const other of prefixes) {
      if (prefixesOverlap(prefix, other)) {
        throw new StrataAnalogConfigurationError(
          prefix === other
            ? `apiBoundary.prefixes declares "${prefix}" more than once.`
            : `apiBoundary.prefixes "${prefix}" and "${other}" overlap; a path may have only one owner.`,
        );
      }
    }
    prefixes.push(prefix);
  }

  const head = value.head === undefined ? "derive" : value.head;
  if (head !== "derive" && head !== "off") {
    throw new StrataAnalogConfigurationError('apiBoundary.head must be "derive" or "off".');
  }

  const options = value.options === undefined ? "off" : value.options;
  if (options !== "allow" && options !== "off") {
    throw new StrataAnalogConfigurationError('apiBoundary.options must be "allow" or "off".');
  }

  const nativeValue: unknown = value.nativeRoutes === undefined ? [] : value.nativeRoutes;
  if (!Array.isArray(nativeValue)) {
    throw new StrataAnalogConfigurationError("apiBoundary.nativeRoutes must be an array.");
  }

  const native: NativeEntry[] = [];
  const seen = new Set<string>();
  for (const entry of nativeValue as readonly unknown[]) {
    if (!isPlainRecord<NativeInput>(entry)) {
      throw new StrataAnalogConfigurationError("apiBoundary.nativeRoutes entries must be objects.");
    }
    rejectUnknownKeys(entry, NATIVE_KEYS, "apiBoundary.nativeRoutes entry");

    const path = entry.path;
    const segments = typeof path === "string" ? compilePattern(path) : undefined;
    if (typeof path !== "string" || !segments) {
      throw new StrataAnalogConfigurationError(
        `Invalid apiBoundary.nativeRoutes path ${JSON.stringify(path)}. Use static and ":param" segments only.`,
      );
    }
    if (!prefixes.some((prefix) => isUnderPrefix(path, prefix))) {
      throw new StrataAnalogConfigurationError(
        `apiBoundary.nativeRoutes path "${path}" is not under a declared prefix (${prefixes.join(", ")}).`,
      );
    }

    const methods: unknown = entry.methods;
    if (!Array.isArray(methods) || methods.length === 0 || !methods.every(isBoundaryMethod)) {
      throw new StrataAnalogConfigurationError(
        `apiBoundary.nativeRoutes "${path}" must declare a non-empty array of HTTP methods ` +
          `(${METHOD_ORDER.join(", ")}).`,
      );
    }

    for (const method of methods) {
      const key = `${method} ${shapeOf(segments)}`;
      if (seen.has(key)) {
        throw new StrataAnalogConfigurationError(
          `apiBoundary.nativeRoutes declares "${method} ${path}" more than once.`,
        );
      }
      seen.add(key);
    }

    native.push({ path, segments, methods: Object.freeze([...new Set(methods)]) });
  }

  return Object.freeze({
    prefixes: Object.freeze(prefixes),
    native: Object.freeze(native),
    head,
    options,
  });
}
