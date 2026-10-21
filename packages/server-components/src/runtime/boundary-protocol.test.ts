import { describe, expect, it, vi } from "vitest";

import {
  MAX_BOUNDARY_PAYLOAD_BYTES,
  MAX_BOUNDARY_PROPS,
  MAX_BOUNDARY_ARRAY_LENGTH,
  MAX_BOUNDARY_DEPTH,
  MAX_BOUNDARY_NODES,
  MAX_BOUNDARY_OBJECT_KEYS,
  STRATA_BOUNDARY_PROTOCOL,
  STRATA_BOUNDARY_PROTOCOL_V2,
  StrataBoundaryError,
  checkBoundaryProps,
  parseBoundaryAttributes,
  serializeBoundary,
  serializeBoundaryProps,
} from "./boundary-protocol.js";
import type { ClientBoundaryProps } from "./client-boundary.js";

const serialize = (props: unknown): string => serializeBoundaryProps("relay-widget", props);

function serializeError(props: unknown): StrataBoundaryError {
  try {
    serialize(props);
  } catch (error) {
    if (error instanceof StrataBoundaryError) return error;
    throw error;
  }

  throw new Error("expected serialization to fail");
}

/** Props of `count` keys, one string value each. */
const propsOf = (count: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, "v"]));

/** `{"text":"<value>"}` is 11 bytes of JSON around the value. */
const JSON_OVERHEAD = '{"text":""}'.length;

describe("serializeBoundaryProps: accepted values", () => {
  interface ProductVariant {
    readonly id: string;
    readonly stock: number;
  }
  interface ProductView {
    readonly id: string;
    readonly variants: readonly ProductVariant[];
  }

  it("accepts consumer-authored readonly interface view models", () => {
    const product: ProductView = { id: "42", variants: [{ id: "black", stock: 12 }] };
    const props: ClientBoundaryProps = { product };
    expect(serialize(props)).toContain('"stock":12');
  });

  it("serializes strings, finite numbers, booleans and null, in own-property order", () => {
    expect(
      serialize({ text: "a", count: 42, ratio: -1.5, enabled: true, off: false, empty: null }),
    ).toBe('{"text":"a","count":42,"ratio":-1.5,"enabled":true,"off":false,"empty":null}');
  });

  it("serializes an empty object", () => {
    expect(serialize({})).toBe("{}");
  });

  it("accepts a null-prototype object", () => {
    const props = Object.assign(Object.create(null) as object, { id: "7" });

    expect(serialize(props)).toBe('{"id":"7"}');
  });

  it("is deterministic and does not sort keys", () => {
    const props = { zeta: 1, alpha: 2 };

    expect(serialize(props)).toBe('{"zeta":1,"alpha":2}');
    expect(serialize(props)).toBe(serialize({ zeta: 1, alpha: 2 }));
  });

  it("round-trips adversarial and non-Latin strings exactly through JSON", () => {
    const text = `"'<>&</script><script>globalThis.__STRATA_XSS__=1</script>\u2028\u2029😀 日本語 Ελληνικά`;
    const parsed = parseBoundaryAttributes({
      protocol: STRATA_BOUNDARY_PROTOCOL,
      props: serialize({ text }),
    });

    expect(parsed).toEqual({ ok: true, value: [["text", text]] });
  });

  it("round-trips XSS-like and Unicode strings inside protocol v2", () => {
    const text = `"' < > & </script><script>globalThis.__STRATA_XSS__=1</script>\u2028\u2029😀 日本語`;
    const serialized = serializeBoundary("product-view", { product: { label: text } });
    const parsed = parseBoundaryAttributes(serialized);

    expect(serialized.protocol).toBe("2");
    expect(parsed).toEqual({ ok: true, value: [["product", { label: text }]] });
  });

  it("writes flat primitive props as v1 and structured view models as v2", () => {
    const flat = serializeBoundary("product-view", { id: "42", enabled: true });
    const structured = serializeBoundary("product-view", {
      product: {
        id: "42",
        name: "Keyboard",
        variants: [
          { id: "black", label: "Black", stock: 12 },
          { id: "white", label: "White", stock: 5 },
        ],
      },
    });

    expect(flat).toEqual({ protocol: "1", props: '{"id":"42","enabled":true}' });
    expect(structured.protocol).toBe(STRATA_BOUNDARY_PROTOCOL_V2);
    expect(JSON.parse(structured.props)).toEqual({
      product: {
        id: "42",
        name: "Keyboard",
        variants: [
          { id: "black", label: "Black", stock: 12 },
          { id: "white", label: "White", stock: 5 },
        ],
      },
    });
    expect(parseBoundaryAttributes(structured)).toMatchObject({ ok: true });
  });

  it("snapshots nested arrays and objects without sharing caller-owned mutable references", () => {
    const product = { variants: [{ id: "a", stock: 2 }] };
    const checked = checkBoundaryProps({ product });
    product.variants[0]!.stock = 99;

    expect(checked).toEqual({
      ok: true,
      value: [["product", { variants: [{ id: "a", stock: 2 }] }]],
    });
  });
});

describe("serializeBoundaryProps: rejected values fail before JSON.stringify", () => {
  class Repository {
    readonly secret = "s";
  }
  const signalLike = Object.assign(() => 1, { set: () => undefined });

  it.each([
    ["undefined", undefined, "undefined is not supported"],
    ["NaN", Number.NaN, "a non-finite number is not supported"],
    ["Infinity", Number.POSITIVE_INFINITY, "a non-finite number is not supported"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "a non-finite number is not supported"],
    ["BigInt", 1n, "BigInt is not supported"],
    ["function", () => "x", "a function"],
    ["signal (a function)", signalLike, "a function"],
    ["symbol", Symbol("s"), "symbol is not supported"],
    ["Date", new Date(0), "a non-plain object is not supported"],
    ["Map", new Map(), "a non-plain object is not supported"],
    ["Set", new Set(), "a non-plain object is not supported"],
    ["RegExp", /x/, "a non-plain object is not supported"],
    ["class instance", new Repository(), "a non-plain object is not supported"],
    ["Promise", Promise.resolve(1), "a non-plain object is not supported"],
  ])("%s", (_, value, reason) => {
    const error = serializeError({ ok: "fine", createdAt: value });

    expect(error.message).toContain("Cannot serialize client boundary <relay-widget>");
    expect(error.message).toContain(`prop "createdAt": ${reason}`);
    expect(error.message).toContain("Allowed values: string | finite number | boolean | null");
  });

  it.each([
    ["an array", ["a"]],
    ["a class instance", new Repository()],
    ["a Date", new Date(0)],
    ["a function", () => ({})],
    ["null", null],
    ["a string", "x"],
  ])("rejects %s as the props object itself", (_, props) => {
    expect(serializeError(props).message).toContain("the props must be a plain object");
  });

  it.each(["__proto__", "prototype", "constructor"])("rejects the reserved key %s", (key) => {
    const props = JSON.parse(`{"${key}": "x"}`) as unknown;

    expect(serializeError(props).message).toContain(`prop "${key}" is a reserved name`);
  });

  it("rejects symbol keys, accessors and non-enumerable props without running getters", () => {
    let getterRan = false;
    const withGetter = Object.defineProperty({}, "lazy", {
      enumerable: true,
      get: () => {
        getterRan = true;

        return "x";
      },
    });

    expect(serializeError({ [Symbol("k")]: "x" }).message).toContain("symbol-keyed property");
    expect(serializeError(withGetter).message).toContain('prop "lazy" is an accessor');
    expect(getterRan).toBe(false);
    expect(
      serializeError(Object.defineProperty({}, "hidden", { value: "x", enumerable: false }))
        .message,
    ).toContain('prop "hidden" is not enumerable');
  });
});

/** A synthetic server-owned value; nothing the diagnostics print may carry it. */
const SECRET = "STRATA_DATA_SECRET_CANARY_UNIT_TEST_0001";

describe("serializeBoundaryProps: diagnostics never print the rejected value", () => {
  class SecretRepository {
    readonly credential = SECRET;
    readonly nested = { deeper: { credential: SECRET } };
    toString(): string {
      throw new Error("toString must not run");
    }
    toJSON(): string {
      throw new Error("toJSON must not run");
    }
    valueOf(): string {
      throw new Error("valueOf must not run");
    }
  }
  const secretFunction = () => SECRET;
  const secretError = new Error(`Synthetic server failure ${SECRET}`);
  const secretPromise = Promise.resolve(SECRET);

  it.each([
    ["the repository (a class instance)", new SecretRepository(), "a non-plain object"],
    ["a function whose source holds the secret", secretFunction, "a function"],
    ["an Error whose message holds the secret", secretError, "a non-plain object"],
    [
      "an unexpected nested Error carrying the secret",
      { nested: { failure: secretError } },
      'prop "repository.nested.failure": a non-plain object',
    ],
    ["a Map of secrets", new Map([["k", SECRET]]), "a non-plain object"],
    ["a Promise of the secret", secretPromise, "a non-plain object"],
    [
      "a null-prototype object holding a class instance",
      Object.assign(Object.create(null) as object, { s: new SecretRepository() }),
      'prop "repository.s": a non-plain object',
    ],
  ])("%s: names the prop and the type, never the contents", (_, value, type) => {
    const stringify = vi.spyOn(JSON, "stringify");

    try {
      const error = serializeError({ label: "fine", repository: value as unknown as string });

      expect(error).toBeInstanceOf(StrataBoundaryError);
      expect(error.message).toContain(
        type.startsWith("prop ") ? type : `prop "repository": ${type}`,
      );
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toMatch(/credential|deeper|[{}]/);
      expect(error.stack ?? "").not.toContain(SECRET);
      // Rejected before serialization: nothing was stringified, nothing coerced.
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("does not run toString, toJSON or valueOf of a rejected value", () => {
    // SecretRepository's methods throw if called: a diagnostic that coerced the
    // value to text would surface that error instead of a StrataBoundaryError.
    expect(serializeError({ repository: new SecretRepository() })).toBeInstanceOf(
      StrataBoundaryError,
    );
  });

  it("rejects the props object itself without printing it", () => {
    const error = serializeError(new SecretRepository());

    expect(error.message).toContain(
      "the props must be a plain object; received a non-plain object",
    );
    expect(error.message).not.toContain(SECRET);
  });

  it("does not print a rejected value in the browser-side diagnostic either", () => {
    const parsed = parseBoundaryAttributes({
      protocol: STRATA_BOUNDARY_PROTOCOL,
      props: JSON.stringify({ configuration: { credential: SECRET } }),
    });

    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toContain("not supported by protocol 1");
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  it("documents the rule it cannot enforce: a string is public data by definition", () => {
    // Strata protects implicit crossings. A developer who passes a secret string
    // explicitly through [strataClient] has made it browser-public.
    expect(serialize({ token: SECRET })).toBe(`{"token":"${SECRET}"}`);
  });

  it("rejects nested accessors and custom serializers without invoking them", () => {
    let getterRan = false;
    let serializerRan = false;
    const withGetter = Object.defineProperty({}, "private", {
      enumerable: true,
      get: () => {
        getterRan = true;
        return SECRET;
      },
    });
    const customSerializer = Object.defineProperty({ public: "yes" }, "toJSON", {
      enumerable: true,
      value: () => {
        serializerRan = true;
        return SECRET;
      },
    });

    expect(serializeError({ product: { detail: withGetter } }).message).toContain(
      'prop "product.detail.private" is an accessor',
    );
    expect(serializeError({ product: customSerializer }).message).toContain(
      'prop "product.toJSON": a function',
    );
    expect(getterRan).toBe(false);
    expect(serializerRan).toBe(false);
  });

  it("does not run inherited conversion hooks while serializing the validated snapshot", () => {
    const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let hookRan = false;
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => {
        hookRan = true;
        return SECRET;
      },
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value: () => {
        hookRan = true;
        return SECRET;
      },
    });
    let json!: string;
    try {
      json = serialize({ product: { variants: [{ id: "public" }] } });
    } finally {
      if (objectHook) Object.defineProperty(Object.prototype, "toJSON", objectHook);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (arrayHook) Object.defineProperty(Array.prototype, "toJSON", arrayHook);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(hookRan).toBe(false);
    expect(json).toBe('{"product":{"variants":[{"id":"public"}]}}');
  });

  it("rejects nested reserved keys, sparse arrays, custom array keys, cycles and throwing proxies", () => {
    const nestedReserved = JSON.parse(
      '{"product":{"variants":[{"constructor":"bad"}]}}',
    ) as unknown;
    const sparse: unknown[] = [];
    sparse.length = 2;
    const customArray = Object.assign([1], { note: "bad" });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(SECRET);
        },
      },
    );

    for (const props of [
      nestedReserved,
      { values: sparse },
      { values: customArray },
      { cycle },
      { cycle: arrayCycle },
      throwingProxy,
    ]) {
      const message = serializeError(props).message;
      expect(message).not.toContain(SECRET);
      expect(message).toContain("Cannot serialize client boundary");
    }
    expect(serializeError({ product: { variants: [{ constructor: "bad" }] } }).message).toContain(
      "reserved key",
    );
    expect(serializeError({ values: sparse }).message).toContain("sparse");
    expect(serializeError({ values: customArray }).message).toContain(
      "unsupported array properties",
    );
    expect(serializeError({ cycle }).message).toContain("circular");
    expect(serializeError({ cycle: arrayCycle }).message).toContain("circular");
    expect(serializeError(throwingProxy).message).toContain("could not be safely inspected");
  });

  it("accepts repeated non-cyclic references but emits independent snapshot data", () => {
    const shared = { label: "public" };
    const checked = checkBoundaryProps({ first: shared, second: shared });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const first = checked.value[0]?.[1] as { label: string };
    const second = checked.value[1]?.[1] as { label: string };
    expect(first).toEqual({ label: "public" });
    expect(second).toEqual({ label: "public" });
    expect(first).not.toBe(second);
  });
});

describe("limits", () => {
  it(`accepts ${MAX_BOUNDARY_PROPS} props and rejects ${MAX_BOUNDARY_PROPS + 1}`, () => {
    expect(() => serialize(propsOf(MAX_BOUNDARY_PROPS))).not.toThrow();
    expect(serializeError(propsOf(MAX_BOUNDARY_PROPS + 1)).message).toContain(
      `${MAX_BOUNDARY_PROPS + 1} props; the limit is ${MAX_BOUNDARY_PROPS}`,
    );
  });

  it("limits UTF-8 bytes, not UTF-16 length", () => {
    // "€" is 1 UTF-16 code unit and 3 UTF-8 bytes.
    const euros = Math.floor((MAX_BOUNDARY_PAYLOAD_BYTES - JSON_OVERHEAD) / 3);
    const atLimit = {
      text: "€".repeat(euros) + "a".repeat(MAX_BOUNDARY_PAYLOAD_BYTES - JSON_OVERHEAD - euros * 3),
    };
    const overByOne = { text: `${atLimit.text}a` };

    expect(new TextEncoder().encode(serialize(atLimit)).length).toBe(MAX_BOUNDARY_PAYLOAD_BYTES);
    expect(serializeError(overByOne).message).toContain(
      `${MAX_BOUNDARY_PAYLOAD_BYTES + 1} UTF-8 bytes; the limit is ${MAX_BOUNDARY_PAYLOAD_BYTES}`,
    );

    // The same multibyte payload is far under the limit if measured in UTF-16 units.
    const multibyteOver = { text: "€".repeat(euros + 1) };

    expect(JSON.stringify(multibyteOver).length).toBeLessThan(MAX_BOUNDARY_PAYLOAD_BYTES);
    expect(serializeError(multibyteOver).message).toContain("UTF-8 bytes; the limit is");
  });

  it("applies the same size limit to the browser payload", () => {
    const props = JSON.stringify({ text: "€".repeat(MAX_BOUNDARY_PAYLOAD_BYTES / 3) });

    expect(parseBoundaryAttributes({ protocol: STRATA_BOUNDARY_PROTOCOL, props })).toMatchObject({
      ok: false,
      problem: expect.stringContaining("UTF-8 bytes; the limit is") as unknown,
    });
  });

  it("measures nested payload size as UTF-8 on both writer and browser", () => {
    const overhead = JSON.stringify({ product: { text: "" } }).length;
    const euros = Math.floor((MAX_BOUNDARY_PAYLOAD_BYTES - overhead) / 3);
    const text = "€".repeat(euros) + "a".repeat(MAX_BOUNDARY_PAYLOAD_BYTES - overhead - euros * 3);
    const accepted = { product: { text } };
    const rejected = { product: { text: `${text}a` } };
    const json = serialize(accepted);

    expect(new TextEncoder().encode(json).length).toBe(MAX_BOUNDARY_PAYLOAD_BYTES);
    expect(serializeError(rejected).message).toContain("UTF-8 bytes; the limit is");
    expect(
      parseBoundaryAttributes({
        protocol: "2",
        props: JSON.stringify(rejected),
      }),
    ).toMatchObject({
      ok: false,
      problem: expect.stringContaining("UTF-8 bytes; the limit is") as unknown,
    });
  });

  it("enforces nested depth, value count, array length, object keys and their next value", () => {
    let atDepth: unknown = "end";
    for (let index = 0; index < MAX_BOUNDARY_DEPTH; index++) atDepth = { child: atDepth };
    let overDepth: unknown = "end";
    for (let index = 0; index <= MAX_BOUNDARY_DEPTH; index++) overDepth = { child: overDepth };
    expect(serialize({ value: atDepth })).toBeTruthy();
    expect(serializeError({ value: overDepth }).message).toContain("maximum nested depth");

    expect(
      serialize({ items: Array.from({ length: MAX_BOUNDARY_ARRAY_LENGTH }, () => null) }),
    ).toBeTruthy();
    expect(
      serializeError({ items: Array.from({ length: MAX_BOUNDARY_ARRAY_LENGTH + 1 }, () => null) })
        .message,
    ).toContain("array items");

    const itemCount = Math.floor((MAX_BOUNDARY_NODES - 4) / 4);
    const atNodeLimit = {
      a: Array.from({ length: itemCount }, () => null),
      b: Array.from({ length: itemCount }, () => null),
      c: Array.from({ length: itemCount }, () => null),
      d: Array.from({ length: itemCount }, () => null),
    };
    const overNodeLimit = { ...atNodeLimit, d: Array.from({ length: itemCount + 1 }, () => null) };
    expect(serialize(atNodeLimit)).toBeTruthy();
    expect(serializeError(overNodeLimit).message).toContain("values");

    const objectAtLimit = Object.fromEntries(
      Array.from({ length: MAX_BOUNDARY_OBJECT_KEYS }, (_, index) => [`k${index}`, null]),
    );
    const objectOverLimit = Object.fromEntries(
      Array.from({ length: MAX_BOUNDARY_OBJECT_KEYS + 1 }, (_, index) => [`k${index}`, null]),
    );
    expect(serialize({ value: objectAtLimit })).toBeTruthy();
    expect(serializeError({ value: objectOverLimit }).message).toContain("object keys");
  });
});

describe("parseBoundaryAttributes: browser re-validation", () => {
  const parse = (protocol: string | null, props: string | null) =>
    parseBoundaryAttributes({ protocol, props });
  const problem = (protocol: string | null, props: string | null): string => {
    const result = parse(protocol, props);

    return result.ok ? "(accepted)" : result.problem;
  };

  it("accepts a well-formed v1 payload", () => {
    expect(parse("1", '{"incidentId":"INC-1","count":2,"open":true,"note":null}')).toEqual({
      ok: true,
      value: [
        ["incidentId", "INC-1"],
        ["count", 2],
        ["open", true],
        ["note", null],
      ],
    });
  });

  it("accepts v2 nested public view data and rejects a v1/v2 shape mismatch", () => {
    const nested = '{"product":{"id":"42","variants":[{"id":"black","stock":12}]}}';
    expect(parse("2", nested)).toEqual({
      ok: true,
      value: [["product", { id: "42", variants: [{ id: "black", stock: 12 }] }]],
    });
    expect(problem("1", nested)).toContain("not supported by protocol 1");
    expect(problem("2", '{"productId":"42"}')).toContain(
      "does not match the boundary payload shape",
    );
  });

  it("treats a missing protocol as incompatible, not as version 1", () => {
    expect(problem(null, "{}")).toContain("data-strata-protocol is missing");
  });

  it("refuses an unknown protocol without parsing the props", () => {
    expect(problem("999", "{broken")).toContain("data-strata-protocol is not a supported version");
    expect(problem("2", "{broken")).toBe("data-strata-props is not valid JSON.");
  });

  it("treats missing props as malformed, not as {}", () => {
    expect(problem("1", null)).toContain("data-strata-props is missing");
  });

  it("reports invalid JSON as a Strata problem", () => {
    expect(problem("1", "{broken")).toBe("data-strata-props is not valid JSON.");
  });

  it("never repeats the engine's parse message, which some engines build from the payload", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      throw new SyntaxError(`Unexpected token in ${text}`);
    });

    try {
      expect(problem("1", '{"token":"PAYLOAD-VALUE" x')).toBe(
        "data-strata-props is not valid JSON.",
      );
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects a JSON __proto__ key (an own property after JSON.parse)", () => {
    expect(problem("1", '{"__proto__":{"polluted":true}}')).toContain(
      'prop "__proto__" is a reserved name',
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it.each([
    ["nested object", '{"a":{"b":1}}', "not supported by protocol 1"],
    ["array", '{"a":[1]}', "not supported by protocol 1"],
    ["array payload", "[1]", "the props must be a plain object"],
    ["string payload", '"x"', "the props must be a plain object"],
    ["null payload", "null", "the props must be a plain object"],
  ])("rejects %s", (_, props, reason) => {
    expect(problem("1", props)).toContain(reason);
  });

  it("applies the prop-count limit", () => {
    expect(parse("1", JSON.stringify(propsOf(MAX_BOUNDARY_PROPS))).ok).toBe(true);
    expect(problem("1", JSON.stringify(propsOf(MAX_BOUNDARY_PROPS + 1)))).toContain(
      `the limit is ${MAX_BOUNDARY_PROPS}`,
    );
  });
});

describe("checkBoundaryProps", () => {
  it("returns validated own entries, never the input object", () => {
    const props = { a: "1" };
    const checked = checkBoundaryProps(props);

    expect(checked).toEqual({ ok: true, value: [["a", "1"]] });
    expect(checked.ok && checked.value).not.toBe(props);
  });
});
