/**
 * Shared validation and encoding for the server writer and browser preflight.
 * Protocol 1 is the original flat primitive format. Protocol 2 adds bounded
 * JSON data, carried on the same host-local attributes.
 */

export const STRATA_BOUNDARY_PROTOCOL_V1 = "1";
export const STRATA_BOUNDARY_PROTOCOL_V2 = "2";
/** The version emitted for simple, flat props. Kept for existing integrations. */
export const STRATA_BOUNDARY_PROTOCOL = STRATA_BOUNDARY_PROTOCOL_V1;

export const BOUNDARY_CLIENT_ATTRIBUTE = "data-strata-client";
export const BOUNDARY_PROTOCOL_ATTRIBUTE = "data-strata-protocol";
export const BOUNDARY_PROPS_ATTRIBUTE = "data-strata-props";
export const BOUNDARY_HYDRATED_ATTRIBUTE = "data-strata-hydrated";

/** At most this many root props and nested object keys per boundary/object. */
export const MAX_BOUNDARY_PROPS = 64;
export const MAX_BOUNDARY_OBJECT_KEYS = 64;
/** Nested containers may be at most this many levels below the root props. */
export const MAX_BOUNDARY_DEPTH = 8;
/** Maximum number of property values and array items across the entire payload. */
export const MAX_BOUNDARY_NODES = 512;
export const MAX_BOUNDARY_ARRAY_LENGTH = 128;
/** At most this many UTF-8 bytes of serialized JSON per boundary (64 KiB). */
export const MAX_BOUNDARY_PAYLOAD_BYTES = 64 * 1024;

export const ALLOWED_BOUNDARY_VALUES =
  "string | finite number | boolean | null | dense arrays | plain objects";

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

export type BoundaryPrimitive = string | number | boolean | null;
export interface BoundaryObject {
  readonly [key: string]: BoundaryValue;
}
export type BoundaryValue = BoundaryPrimitive | readonly BoundaryValue[] | BoundaryObject;

/** Validated own props, in the object's own-property order. */
export type BoundaryEntries = readonly (readonly [string, BoundaryValue])[];

export class StrataBoundaryError extends Error {
  override readonly name = "StrataBoundaryError";
}

type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

const fail = (problem: string): { readonly ok: false; readonly problem: string } => ({
  ok: false,
  problem,
});

function utf8Length(text: string): number {
  // Every UTF-16 code unit encodes to at least one UTF-8 byte. Avoid allocating
  // an encoded copy when even that lower bound is already above the limit.
  return text.length > MAX_BOUNDARY_PAYLOAD_BYTES
    ? text.length
    : new TextEncoder().encode(text).length;
}

const sizeProblem = (bytes: number): string =>
  `the serialized props are ${bytes} UTF-8 bytes; the limit is ${MAX_BOUNDARY_PAYLOAD_BYTES}.`;

function safePath(path: string): string {
  return path.length > 160 ? `${path.slice(0, 157)}...` : path;
}

function valueCategory(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return "BigInt";
  if (typeof value === "symbol") return "symbol";
  if (typeof value === "function") return "a function (functions, closures and signals)";
  if (typeof value === "number") return "a non-finite number";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object" && value !== null) return "a non-plain object";
  return typeof value;
}

function isPrimitive(value: unknown): value is BoundaryPrimitive {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function descriptorValue(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): Checked<unknown> {
  if (!descriptor) return fail(`prop "${safePath(path)}" changed during inspection.`);
  if (!("value" in descriptor)) {
    return fail(
      `prop "${safePath(path)}" is an accessor (getter/setter); only data properties cross.`,
    );
  }
  if (!descriptor.enumerable) return fail(`prop "${safePath(path)}" is not enumerable.`);
  return { ok: true, value: descriptor.value as unknown };
}

/**
 * Validate by descriptors and copy to a fresh JSON-shaped snapshot. Recursion
 * is bounded by MAX_BOUNDARY_DEPTH, so hostile nesting cannot exhaust the
 * stack. Only the current ancestor set is tracked: repeated non-cyclic
 * references are copied independently, while cycles fail closed.
 */
export function checkBoundaryProps(
  props: unknown,
  allowStructured = true,
): Checked<BoundaryEntries> {
  try {
    if (typeof props !== "object" || props === null || Array.isArray(props)) {
      return fail(`the props must be a plain object; received ${valueCategory(props)}.`);
    }

    const rootPrototype = Object.getPrototypeOf(props) as unknown;
    if (rootPrototype !== Object.prototype && rootPrototype !== null) {
      return fail(`the props must be a plain object; received ${valueCategory(props)}.`);
    }

    const rootKeys = Reflect.ownKeys(props);
    if (rootKeys.length > MAX_BOUNDARY_PROPS) {
      return fail(`${rootKeys.length} props; the limit is ${MAX_BOUNDARY_PROPS}.`);
    }

    let nodes = 0;
    const ancestors = new WeakSet<object>();
    const copyValue = (value: unknown, path: string, depth: number): Checked<BoundaryValue> => {
      nodes++;
      if (nodes > MAX_BOUNDARY_NODES) {
        return fail(
          `the payload has more than ${MAX_BOUNDARY_NODES} values (limit ${MAX_BOUNDARY_NODES}).`,
        );
      }
      if (isPrimitive(value)) return { ok: true, value };
      if (!allowStructured) {
        return fail(
          `prop "${safePath(path)}": ${valueCategory(value)} is not supported by protocol 1.`,
        );
      }
      if (typeof value !== "object" || value === null) {
        return fail(`prop "${safePath(path)}": ${valueCategory(value)} is not supported.`);
      }

      if (depth >= MAX_BOUNDARY_DEPTH) {
        return fail(
          `prop "${safePath(path)}" exceeds the maximum nested depth of ${MAX_BOUNDARY_DEPTH}.`,
        );
      }
      if (ancestors.has(value)) return fail(`prop "${safePath(path)}" is circular.`);
      ancestors.add(value);

      let copied: BoundaryValue;
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          ancestors.delete(value);
          return fail(`prop "${safePath(path)}" has an unsupported array prototype.`);
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!lengthDescriptor || !("value" in lengthDescriptor)) {
          ancestors.delete(value);
          return fail(`prop "${safePath(path)}" has an invalid array length.`);
        }
        const length = lengthDescriptor.value as number;
        if (length > MAX_BOUNDARY_ARRAY_LENGTH) {
          ancestors.delete(value);
          return fail(
            `prop "${safePath(path)}" has ${length} items; the limit is ${MAX_BOUNDARY_ARRAY_LENGTH}.`,
          );
        }
        const keys = Reflect.ownKeys(value);
        if (
          keys.length !== length + 1 ||
          keys.some(
            (key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
          )
        ) {
          ancestors.delete(value);
          return fail(`prop "${safePath(path)}" is sparse or has unsupported array properties.`);
        }
        const result: BoundaryValue[] = [];
        for (let index = 0; index < length; index++) {
          const itemPath = `${path}[${index}]`;
          const item = descriptorValue(
            Object.getOwnPropertyDescriptor(value, String(index)),
            itemPath,
          );
          if (!item.ok) {
            ancestors.delete(value);
            return item;
          }
          const child = copyValue(item.value, itemPath, depth + 1);
          if (!child.ok) {
            ancestors.delete(value);
            return child;
          }
          result.push(child.value);
        }
        copied = result;
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          ancestors.delete(value);
          return fail(`prop "${safePath(path)}": ${valueCategory(value)} is not supported.`);
        }
        const keys = Reflect.ownKeys(value);
        if (keys.length > MAX_BOUNDARY_OBJECT_KEYS) {
          ancestors.delete(value);
          return fail(
            `prop "${safePath(path)}" has ${keys.length} keys; the limit is ${MAX_BOUNDARY_OBJECT_KEYS}.`,
          );
        }
        const result: Record<string, BoundaryValue> = Object.create(null) as Record<
          string,
          BoundaryValue
        >;
        for (const key of keys) {
          if (typeof key === "symbol") {
            ancestors.delete(value);
            return fail(`prop "${safePath(path)}" contains a symbol-keyed property.`);
          }
          if (FORBIDDEN_KEYS.has(key)) {
            ancestors.delete(value);
            return fail(
              `prop "${safePath(path)}.${safePath(key)}" uses a reserved key (__proto__, prototype, constructor).`,
            );
          }
          const childPath = path ? `${path}.${key}` : key;
          const childDescriptor = descriptorValue(
            Object.getOwnPropertyDescriptor(value, key),
            childPath,
          );
          if (!childDescriptor.ok) {
            ancestors.delete(value);
            return childDescriptor;
          }
          const child = copyValue(childDescriptor.value, childPath, depth + 1);
          if (!child.ok) {
            ancestors.delete(value);
            return child;
          }
          // Dangerous prototype-related names were rejected above; this is a
          // fresh null-prototype snapshot, never a copy into caller data.
          result[key] = child.value;
        }
        copied = result;
      }
      ancestors.delete(value);
      return { ok: true, value: copied };
    };

    const entries: (readonly [string, BoundaryValue])[] = [];
    for (const key of rootKeys) {
      if (typeof key !== "string") return fail("the props contain a symbol-keyed property.");
      if (FORBIDDEN_KEYS.has(key)) {
        return fail(
          `prop "${safePath(key)}" is a reserved name (__proto__, prototype, constructor) and cannot cross.`,
        );
      }
      const descriptor = descriptorValue(Object.getOwnPropertyDescriptor(props, key), key);
      if (!descriptor.ok) return descriptor;
      const checked = copyValue(descriptor.value, key, 0);
      if (!checked.ok) return checked;
      entries.push([key, checked.value]);
    }
    return { ok: true, value: entries };
  } catch {
    // Proxy traps and exotic reflection can throw arbitrary values. Never let
    // those values or engine messages escape the security boundary.
    return fail("the props could not be safely inspected.");
  }
}

function hasStructuredValue(value: BoundaryValue): boolean {
  if (Array.isArray(value)) return true;
  if (value !== null && typeof value === "object") return true;
  return false;
}

function jsonSafeSnapshot(value: BoundaryValue): BoundaryValue {
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) {
    const copy: BoundaryValue[] = [];
    for (const item of value as readonly BoundaryValue[]) copy.push(jsonSafeSnapshot(item));
    // Prevent inherited Array.prototype.toJSON hooks from observing values.
    Object.setPrototypeOf(copy, null);
    return copy;
  }
  const objectValue = value as BoundaryObject;
  const copy: Record<string, BoundaryValue> = Object.create(null) as Record<string, BoundaryValue>;
  for (const key of Object.keys(objectValue)) copy[key] = jsonSafeSnapshot(objectValue[key]!);
  return copy;
}

export interface SerializedBoundary {
  readonly protocol: string;
  readonly props: string;
}

export function serializeBoundary(selector: string, props: unknown): SerializedBoundary {
  const checked = checkBoundaryProps(props);
  const reject = (problem: string): never => {
    throw new StrataBoundaryError(
      `[strata] Cannot serialize client boundary <${selector}>: ${problem}\n` +
        `Allowed values: ${ALLOWED_BOUNDARY_VALUES}; maximum depth ${MAX_BOUNDARY_DEPTH}, ` +
        `${MAX_BOUNDARY_NODES} values, ${MAX_BOUNDARY_ARRAY_LENGTH} array items, ` +
        `${MAX_BOUNDARY_OBJECT_KEYS} object keys, ${MAX_BOUNDARY_PROPS} root props and ` +
        `${MAX_BOUNDARY_PAYLOAD_BYTES} UTF-8 bytes. Everything in [strataClient] is public browser data.`,
    );
  };
  if (!checked.ok) return reject(checked.problem);
  const structured = checked.value.some(([, value]) => hasStructuredValue(value));
  const protocol = structured ? STRATA_BOUNDARY_PROTOCOL_V2 : STRATA_BOUNDARY_PROTOCOL_V1;
  const jsonRoot: Record<string, BoundaryValue> = Object.create(null) as Record<
    string,
    BoundaryValue
  >;
  for (const [key, value] of checked.value) jsonRoot[key] = jsonSafeSnapshot(value);
  const json = JSON.stringify(jsonRoot);
  const bytes = utf8Length(json);
  if (bytes > MAX_BOUNDARY_PAYLOAD_BYTES) return reject(sizeProblem(bytes));
  return { protocol, props: json };
}

/** Compatibility helper retained for internal tests and existing callers. */
export function serializeBoundaryProps(selector: string, props: unknown): string {
  return serializeBoundary(selector, props).props;
}

export interface BoundaryAttributes {
  readonly protocol: string | null;
  readonly props: string | null;
}

export function parseBoundaryAttributes(attributes: BoundaryAttributes): Checked<BoundaryEntries> {
  const { protocol, props } = attributes;
  if (protocol === null) return fail(`${BOUNDARY_PROTOCOL_ATTRIBUTE} is missing.`);
  if (protocol !== STRATA_BOUNDARY_PROTOCOL_V1 && protocol !== STRATA_BOUNDARY_PROTOCOL_V2) {
    return fail(`${BOUNDARY_PROTOCOL_ATTRIBUTE} is not a supported version.`);
  }
  if (props === null) return fail(`${BOUNDARY_PROPS_ATTRIBUTE} is missing.`);
  const bytes = utf8Length(props);
  if (bytes > MAX_BOUNDARY_PAYLOAD_BYTES) return fail(sizeProblem(bytes));

  let parsed: unknown;
  try {
    parsed = JSON.parse(props) as unknown;
  } catch {
    return fail(`${BOUNDARY_PROPS_ATTRIBUTE} is not valid JSON.`);
  }
  const checked = checkBoundaryProps(parsed, protocol === STRATA_BOUNDARY_PROTOCOL_V2);
  if (!checked.ok) return checked;
  const structured = checked.value.some(([, value]) => hasStructuredValue(value));
  if ((protocol === STRATA_BOUNDARY_PROTOCOL_V2) !== structured) {
    return fail(`${BOUNDARY_PROTOCOL_ATTRIBUTE} does not match the boundary payload shape.`);
  }
  return checked;
}
