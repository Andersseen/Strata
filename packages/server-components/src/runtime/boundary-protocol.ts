/**
 * The client boundary protocol, version 1: what a `[strataClient]` boundary
 * writes on its SSR host element and what the browser accepts back. Shared by
 * the server serializer (client-boundary.ts) and the browser preflight
 * (hydration-plan.ts). Internal: not exported from the package entry.
 *
 * A boundary is identified by its concrete SSR host element, which carries
 * all of it at once: `data-strata-client` (the element's own selector),
 * `data-strata-protocol`, `data-strata-props` and Angular's `ngh` annotation.
 * There is no global payload, registry or boundary id to correlate.
 */

/** The only protocol version this runtime writes and accepts. */
export const STRATA_BOUNDARY_PROTOCOL = "1";

export const BOUNDARY_CLIENT_ATTRIBUTE = "data-strata-client";
export const BOUNDARY_PROTOCOL_ATTRIBUTE = "data-strata-protocol";
export const BOUNDARY_PROPS_ATTRIBUTE = "data-strata-props";
/** Written by the browser once every boundary of a Server Component host is hydrated. */
export const BOUNDARY_HYDRATED_ATTRIBUTE = "data-strata-hydrated";

/** At most this many props per boundary. */
export const MAX_BOUNDARY_PROPS = 64;
/** At most this many UTF-8 bytes of serialized JSON per boundary (64 KiB). */
export const MAX_BOUNDARY_PAYLOAD_BYTES = 64 * 1024;

export const ALLOWED_BOUNDARY_VALUES = "string | finite number | boolean | null";

/** Names that are never Angular inputs here and only complicate the trust boundary. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

export type BoundaryValue = string | number | boolean | null;

/** Validated own props, in the object's own-property order. */
export type BoundaryEntries = readonly (readonly [string, BoundaryValue])[];

/** A protocol violation, server- or browser-side. Internal. */
export class StrataBoundaryError extends Error {
  override readonly name = "StrataBoundaryError";
}

type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const fail = (problem: string): { readonly ok: false; readonly problem: string } => ({
  ok: false,
  problem,
});

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return "BigInt";
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "function") return "a function (functions, closures and signals)";
  if (typeof value === "number") return `the non-finite number ${String(value)}`;
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (value instanceof RegExp) return "RegExp";

  if (typeof value === "object" && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);

    if (prototype === Object.prototype || prototype === null) return "a nested object";

    const name = (prototype as { constructor?: { name?: unknown } }).constructor?.name;

    return typeof name === "string" && name ? `an instance of ${name}` : "a class instance";
  }

  return typeof value;
}

function isBoundaryValue(value: unknown): value is BoundaryValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    // JSON would silently write NaN and ±Infinity as null.
    (typeof value === "number" && Number.isFinite(value))
  );
}

function utf8Length(text: string): number {
  // Every UTF-16 code unit encodes to at least one UTF-8 byte: skip encoding
  // a string that is over the limit by its length alone.
  return text.length > MAX_BOUNDARY_PAYLOAD_BYTES
    ? text.length
    : new TextEncoder().encode(text).length;
}

const sizeProblem = (bytes: number): string =>
  `the serialized props are ${bytes} UTF-8 bytes; the limit is ${MAX_BOUNDARY_PAYLOAD_BYTES}.`;

/**
 * The value contract, shared by both sides: a plain, non-array object
 * (prototype `Object.prototype` or `null`) of at most MAX_BOUNDARY_PROPS own,
 * enumerable, string-keyed data properties, each a string, finite number,
 * boolean or null. Reads every property once, through its descriptor: no
 * getter runs.
 */
export function checkBoundaryProps(props: unknown): Checked<BoundaryEntries> {
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    return fail(`the props must be a plain object; received ${describe(props)}.`);
  }

  const prototype: unknown = Object.getPrototypeOf(props);

  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`the props must be a plain object; received ${describe(props)}.`);
  }

  const keys = Reflect.ownKeys(props);

  if (keys.length > MAX_BOUNDARY_PROPS) {
    return fail(`${keys.length} props; the limit is ${MAX_BOUNDARY_PROPS}.`);
  }

  const entries: (readonly [string, BoundaryValue])[] = [];

  for (const key of keys) {
    if (typeof key === "symbol")
      return fail(`a symbol-keyed prop (${String(key)}) is not supported.`);
    if (FORBIDDEN_KEYS.has(key)) {
      return fail(
        `prop "${key}" is a reserved name (__proto__, prototype, constructor) and cannot cross.`,
      );
    }

    const descriptor = Object.getOwnPropertyDescriptor(props, key);

    if (!descriptor || !("value" in descriptor)) {
      return fail(`prop "${key}" is an accessor (getter/setter); only data properties cross.`);
    }

    if (!descriptor.enumerable) return fail(`prop "${key}" is not enumerable.`);

    const value: unknown = descriptor.value;

    if (!isBoundaryValue(value)) return fail(`prop "${key}": ${describe(value)} is not supported.`);

    entries.push([key, value]);
  }

  return { ok: true, value: entries };
}

/**
 * Server side: validates `props` and serializes them for `data-strata-props`.
 * Throws a StrataBoundaryError naming the boundary, the prop and the allowed
 * value set; nothing is dropped, coerced or stringified on a violation.
 * Deterministic: JSON of the validated entries, in own-property order.
 */
export function serializeBoundaryProps(selector: string, props: unknown): string {
  const checked = checkBoundaryProps(props);
  const reject = (problem: string): never => {
    throw new StrataBoundaryError(
      `[strata] Cannot serialize client boundary <${selector}>: ${problem}\n` +
        `Allowed values: ${ALLOWED_BOUNDARY_VALUES}, in one flat plain object of at most ` +
        `${MAX_BOUNDARY_PROPS} props and ${MAX_BOUNDARY_PAYLOAD_BYTES} UTF-8 bytes serialized. ` +
        "Everything in [strataClient] is public browser data: reduce server values to explicit " +
        "primitive props before they cross.",
    );
  };

  if (!checked.ok) return reject(checked.problem);

  const json = JSON.stringify(Object.fromEntries(checked.value));
  const bytes = utf8Length(json);

  return bytes > MAX_BOUNDARY_PAYLOAD_BYTES ? reject(sizeProblem(bytes)) : json;
}

/** A boundary's protocol and props attributes, as read from its SSR host element. */
export interface BoundaryAttributes {
  readonly protocol: string | null;
  readonly props: string | null;
}

/**
 * Browser side: re-validates what the server wrote, which may be stale,
 * modified or corrupted. A missing or unknown protocol is incompatible (no
 * best-effort parse); a missing props attribute is malformed (Strata always
 * writes one, `{}` included).
 */
export function parseBoundaryAttributes(attributes: BoundaryAttributes): Checked<BoundaryEntries> {
  const { protocol, props } = attributes;

  if (protocol === null) {
    return fail(
      `${BOUNDARY_PROTOCOL_ATTRIBUTE} is missing; this runtime accepts only protocol "${STRATA_BOUNDARY_PROTOCOL}".`,
    );
  }

  if (protocol !== STRATA_BOUNDARY_PROTOCOL) {
    return fail(
      `${BOUNDARY_PROTOCOL_ATTRIBUTE}="${protocol}" is not supported by this runtime, which accepts only "${STRATA_BOUNDARY_PROTOCOL}" (server markup and browser runtime are out of sync).`,
    );
  }

  if (props === null) return fail(`${BOUNDARY_PROPS_ATTRIBUTE} is missing.`);

  const bytes = utf8Length(props);

  if (bytes > MAX_BOUNDARY_PAYLOAD_BYTES) return fail(sizeProblem(bytes));

  let parsed: unknown;

  try {
    parsed = JSON.parse(props);
  } catch {
    // Not the engine's message: some engines quote part of the payload in it.
    return fail(`${BOUNDARY_PROPS_ATTRIBUTE} is not valid JSON.`);
  }

  return checkBoundaryProps(parsed);
}
