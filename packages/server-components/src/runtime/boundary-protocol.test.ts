import { describe, expect, it } from "vitest";

import {
  MAX_BOUNDARY_PAYLOAD_BYTES,
  MAX_BOUNDARY_PROPS,
  STRATA_BOUNDARY_PROTOCOL,
  StrataBoundaryError,
  checkBoundaryProps,
  parseBoundaryAttributes,
  serializeBoundaryProps,
} from "./boundary-protocol.js";

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
});

describe("serializeBoundaryProps: rejected values fail before JSON.stringify", () => {
  class Repository {
    readonly secret = "s";
  }
  const signalLike = Object.assign(() => 1, { set: () => undefined });

  it.each([
    ["undefined", undefined, "undefined is not supported"],
    ["NaN", Number.NaN, "the non-finite number NaN is not supported"],
    ["Infinity", Number.POSITIVE_INFINITY, "the non-finite number Infinity"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "the non-finite number -Infinity"],
    ["BigInt", 1n, "BigInt is not supported"],
    ["function", () => "x", "a function"],
    ["signal (a function)", signalLike, "a function"],
    ["symbol", Symbol("s"), "symbol is not supported"],
    ["array", ["a"], "an array is not supported"],
    ["plain nested object", { a: 1 }, "a nested object is not supported"],
    ["Date", new Date(0), "Date is not supported"],
    ["Map", new Map(), "Map is not supported"],
    ["Set", new Set(), "Set is not supported"],
    ["RegExp", /x/, "RegExp is not supported"],
    ["class instance", new Repository(), "an instance of Repository is not supported"],
    ["Promise", Promise.resolve(1), "an instance of Promise is not supported"],
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

    expect(serializeError({ [Symbol("k")]: "x" }).message).toContain("symbol-keyed prop");
    expect(serializeError(withGetter).message).toContain('prop "lazy" is an accessor');
    expect(getterRan).toBe(false);
    expect(
      serializeError(Object.defineProperty({}, "hidden", { value: "x", enumerable: false }))
        .message,
    ).toContain('prop "hidden" is not enumerable');
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

  it("treats a missing protocol as incompatible, not as version 1", () => {
    expect(problem(null, "{}")).toContain("data-strata-protocol is missing");
  });

  it("refuses an unknown protocol without parsing the props", () => {
    expect(problem("2", "{broken")).toContain('data-strata-protocol="2" is not supported');
    expect(problem("999", "{}")).toContain('accepts only "1"');
  });

  it("treats missing props as malformed, not as {}", () => {
    expect(problem("1", null)).toContain("data-strata-props is missing");
  });

  it("reports invalid JSON as a Strata problem", () => {
    expect(problem("1", "{broken")).toMatch(/^data-strata-props is not valid JSON \(/);
  });

  it("rejects a JSON __proto__ key (an own property after JSON.parse)", () => {
    expect(problem("1", '{"__proto__":{"polluted":true}}')).toContain(
      'prop "__proto__" is a reserved name',
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it.each([
    ["nested object", '{"a":{"b":1}}', "a nested object"],
    ["array", '{"a":[1]}', "an array"],
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
