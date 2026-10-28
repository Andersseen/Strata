import { describe, expect, it } from "vitest";

import {
  MAX_CLIENT_BOUNDARIES_PER_HOST,
  MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST,
  StrataBoundaryError,
  StrataBuildMismatchError,
  boundaryPayloadUtf8Bytes,
} from "./boundary-protocol.js";
import { BOUNDARY_HOST_SELECTOR, planClientBoundaries } from "./hydration-plan.js";
import type { BoundaryHost, ClientReference } from "./hydration-plan.js";

/** A DOM-free stand-in for an SSR host element: its tag and attributes. */
class FakeHost implements BoundaryHost {
  constructor(
    readonly localName: string,
    private readonly attributes: Readonly<Record<string, string>>,
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }
}

const boundary = (
  localName: string,
  props: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): FakeHost =>
  new FakeHost(
    localName,
    Object.fromEntries(
      Object.entries({
        "data-strata-client": localName,
        "data-strata-protocol": "1",
        "data-strata-props": props,
        ...overrides,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );

class Triage {}
class Window {}
class ProductView {}

/** As built from `reflectComponentType`: propName → public templateName. */
const references = new Map<string, ClientReference>([
  [
    "relay-triage",
    {
      type: Triage,
      selector: "relay-triage",
      inputs: new Map([
        ["incidentId", "incidentId"],
        ["initialStatus", "initialStatus"],
      ]),
    },
  ],
  [
    "relay-window",
    {
      type: Window,
      selector: "relay-window",
      // `readonly caption = input.required<string>({ alias: "label" })`
      inputs: new Map([["caption", "label"]]),
    },
  ],
  [
    "relay-product-view",
    {
      type: ProductView,
      selector: "relay-product-view",
      inputs: new Map([["product", "product"]]),
    },
  ],
]);

const plan = (hosts: readonly FakeHost[]) =>
  planClientBoundaries("relay-digest", hosts, references);

function planError(hosts: readonly FakeHost[]): string {
  try {
    plan(hosts);
  } catch (error) {
    if (error instanceof StrataBoundaryError) return error.message;
    throw error;
  }

  throw new Error("expected preflight to fail");
}

const valid = (id = "INC-1") => boundary("relay-triage", JSON.stringify({ incidentId: id }));
const v2Product = () =>
  new FakeHost("relay-product-view", {
    "data-strata-client": "relay-product-view",
    "data-strata-protocol": "2",
    "data-strata-props": JSON.stringify({ product: { id: "42", variants: [{ id: "black" }] } }),
  });

describe("planClientBoundaries", () => {
  it("plans every boundary on its own host, in document order", () => {
    const a = valid("INC-1");
    const b = boundary("relay-window", '{"label":"Observation window"}');
    const planned = plan([a, b]);

    expect(planned).toEqual([
      { host: a, type: Triage, props: [["incidentId", "INC-1"]] },
      { host: b, type: Window, props: [["label", "Observation window"]] },
    ]);
  });

  it("assigns each v2 object payload to its public input on that boundary host", () => {
    const host = v2Product();
    const planned = plan([host]);

    expect(planned).toEqual([
      { host, type: ProductView, props: [["product", { id: "42", variants: [{ id: "black" }] }]] },
    ]);
  });

  it("preflights mixed v1 and v2 boundaries independently under the same host", () => {
    const primitive = valid("legacy");
    const structured = v2Product();
    const planned = plan([primitive, structured]);

    expect(planned.map((entry) => entry.host)).toEqual([primitive, structured]);
    expect(planned[0]?.props).toEqual([["incidentId", "legacy"]]);
    expect(planned[1]?.props).toEqual([["product", { id: "42", variants: [{ id: "black" }] }]]);
    expect(planned[0]?.props[0]?.[1]).not.toBe(planned[1]?.props[0]?.[1]);
  });

  it("keeps identical selector + identical props as distinct boundaries (identity is the host)", () => {
    const a = valid("INC-1");
    const b = valid("INC-1");
    const planned = plan([a, b]);

    expect(planned).toHaveLength(2);
    expect(planned[0]?.host).toBe(a);
    expect(planned[1]?.host).toBe(b);
    expect(planned[0]?.host).not.toBe(planned[1]?.host);
  });

  it("accepts an aliased input by its public name only", () => {
    expect(plan([boundary("relay-window", '{"label":"x"}')])).toHaveLength(1);
    expect(planError([boundary("relay-window", '{"caption":"x"}')])).toContain(
      'prop "caption" is not a public input name; the input\'s public (aliased) name is "label".',
    );
  });

  it.each([
    ["invalid JSON", boundary("relay-triage", "{broken"), "data-strata-props is not valid JSON"],
    [
      "missing protocol",
      boundary("relay-triage", "{}", { "data-strata-protocol": undefined }),
      "data-strata-protocol is missing",
    ],
    [
      "unknown protocol",
      boundary("relay-triage", "{}", { "data-strata-protocol": "999" }),
      "data-strata-protocol is not a supported version",
    ],
    [
      "missing props",
      boundary("relay-triage", "{}", { "data-strata-props": undefined }),
      "data-strata-props is missing",
    ],
    [
      "dangerous key",
      boundary("relay-triage", '{"__proto__":{"x":1}}'),
      'prop "__proto__" is a reserved name',
    ],
    [
      "v1 nested value",
      boundary("relay-triage", '{"incidentId":{"id":1}}'),
      'prop "incidentId": a non-plain object is not supported by protocol 1.',
    ],
    [
      "unknown input",
      boundary("relay-triage", '{"doesNotExist":1}'),
      'prop "doesNotExist" is not an input of the component',
    ],
    [
      "selector mismatch (attribute vs host element)",
      boundary("relay-window", "{}", { "data-strata-client": "relay-triage" }),
      "data-strata-client does not match its host element selector <relay-window>",
    ],
    [
      "missing client attribute",
      boundary("relay-triage", "{}", { "data-strata-client": undefined }),
      "data-strata-client is missing",
    ],
    [
      "no client reference",
      boundary("other-widget", "{}"),
      "no client reference has this selector",
    ],
  ])("fails preflight for %s, with no plan for any boundary", (_, bad, reason) => {
    const message = planError([valid("A"), bad, valid("C")]);

    expect(message).toContain(
      `[strata] Cannot hydrate client boundary <${bad.localName}> (boundary 2 of 3 in <relay-digest>): ${reason}`,
    );
    expect(message).toContain("No client boundary in <relay-digest> was hydrated");
  });

  it("fails when the client reference's selector differs from the host", () => {
    const skewed = new Map(references).set("relay-triage", {
      ...references.get("relay-triage")!,
      selector: "relay-other",
    });

    expect(() => planClientBoundaries("relay-digest", [valid()], skewed)).toThrow(
      'its client reference has selector "relay-other", not "relay-triage"',
    );
  });

  it("plans nothing for no boundaries", () => {
    expect(plan([])).toEqual([]);
  });

  it("accepts the exact per-host boundary count and refuses one above it", () => {
    expect(
      plan(Array.from({ length: MAX_CLIENT_BOUNDARIES_PER_HOST }, () => valid())),
    ).toHaveLength(MAX_CLIENT_BOUNDARIES_PER_HOST);

    const failure = planFailure(
      Array.from({ length: MAX_CLIENT_BOUNDARIES_PER_HOST + 1 }, () => valid()),
    );
    expect(failure).toBeInstanceOf(StrataBoundaryError);
    expect(failure?.category).toBe("resource-limit");
    expect(failure?.message).toContain(`limit of ${MAX_CLIENT_BOUNDARIES_PER_HOST}`);
  });

  it.each([0, 1, 8, 32, 64, 128])("plans %i individually valid boundaries", (count) => {
    expect(plan(Array.from({ length: count }, () => valid()))).toHaveLength(count);
  });

  it("refuses the 256-boundary aggregate that the baseline planner accepted", () => {
    const failure = planFailure(Array.from({ length: 256 }, () => valid()));

    expect(failure?.category).toBe("resource-limit");
  });

  it("classifies an over-budget host as a resource refusal before build-skew recovery", () => {
    for (const serverBuild of ["a1", "b2"]) {
      const hosts = Array.from({ length: MAX_CLIENT_BOUNDARIES_PER_HOST + 1 }, () =>
        stamped(serverBuild),
      );
      const failure = planFailure(hosts, "a1");

      expect(failure).toBeInstanceOf(StrataBoundaryError);
      expect(failure).not.toBeInstanceOf(StrataBuildMismatchError);
      expect(failure?.category).toBe("resource-limit");
    }
  });

  it("accounts UTF-8 payload bytes exactly, without counting missing attributes", () => {
    expect(boundaryPayloadUtf8Bytes("")).toBe(0);
    expect(boundaryPayloadUtf8Bytes("plain ASCII")).toBe(11);
    expect(boundaryPayloadUtf8Bytes("é")).toBe(2);
    expect(boundaryPayloadUtf8Bytes("🙂")).toBe(4);
    expect(boundaryPayloadUtf8Bytes('\\"\\n')).toBe(4);

    const missing = boundary("relay-triage", "{}", { "data-strata-props": undefined });
    expect(() => planClientBoundaries("relay-digest", [missing], references)).toThrow(
      /data-strata-props is missing/,
    );
  });

  it("accepts the exact aggregate byte limit and refuses one byte above it", () => {
    const payload = (length: number) =>
      `{"incidentId":"${"x".repeat(length - '{"incidentId":""}'.length)}"}`;
    const sized = (serialized: string) =>
      new FakeHost("relay-triage", {
        "data-strata-client": "relay-triage",
        "data-strata-protocol": "1",
        "data-strata-props": serialized,
      });
    const full = payload(64 * 1024);
    expect(boundaryPayloadUtf8Bytes(full)).toBe(64 * 1024);
    expect(plan(Array.from({ length: 16 }, () => sized(full)))).toHaveLength(
      MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST / (64 * 1024),
    );

    const exactWithoutOne = Array.from({ length: 15 }, () => sized(full));
    exactWithoutOne.push(sized(payload(64 * 1024 - 16)));
    exactWithoutOne.push(sized(payload(17)));
    const total = exactWithoutOne.reduce(
      (sum, host) => sum + boundaryPayloadUtf8Bytes(host.getAttribute("data-strata-props")!),
      0,
    );
    expect(total).toBe(MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST + 1);

    const failure = planFailure(exactWithoutOne);
    expect(failure?.category).toBe("resource-limit");
    expect(failure?.message).toContain(`${MAX_CLIENT_BOUNDARY_PAYLOAD_BYTES_PER_HOST} UTF-8 bytes`);
    expect(failure?.message).not.toContain("incidentId");
  });
});

function planFailure(
  hosts: readonly FakeHost[],
  browserBuildId?: string,
): StrataBoundaryError | undefined {
  try {
    planClientBoundaries("relay-digest", hosts, references, browserBuildId);
  } catch (error) {
    if (error instanceof StrataBoundaryError) return error;
    throw error;
  }

  return undefined;
}

const stamped = (build: string | undefined, overrides: Record<string, string | undefined> = {}) =>
  boundary("relay-triage", '{"incidentId":"INC-1"}', { "data-strata-build": build, ...overrides });

describe("planClientBoundaries build identity", () => {
  it("hydrates a boundary from the same build and ignores the attribute when not enforced", () => {
    expect(planClientBoundaries("relay-digest", [stamped("a1")], references, "a1")).toHaveLength(1);
    // An application that did not enable the identity behaves as before.
    for (const attribute of ["b2", undefined, "not valid!"]) {
      expect(planClientBoundaries("relay-digest", [stamped(attribute)], references)).toHaveLength(
        1,
      );
    }
  });

  it("reports a well-formed, different identity as a build mismatch before anything else", () => {
    // The registry, the protocol and the props are all wrong too: the build is the root cause.
    const host = new FakeHost("relay-unknown", {
      "data-strata-client": "relay-unknown",
      "data-strata-protocol": "9",
      "data-strata-props": "{",
      "data-strata-build": "b2",
    });
    const failure = planFailure([host], "a1");

    expect(failure).toBeInstanceOf(StrataBuildMismatchError);
    expect(failure?.category).toBe("build-mismatch");
    expect((failure as StrataBuildMismatchError).browserBuildId).toBe("a1");
    expect((failure as StrataBuildMismatchError).serverBuildId).toBe("b2");
    expect(failure?.message).toContain('application build "a1"');
    expect(failure?.message).toContain('build "b2"');
    expect(failure?.message).toContain("No client boundary in <relay-digest> was hydrated");
  });

  it("keeps the other failure classes distinct and never calls them a deployment skew", () => {
    const cases: [string, FakeHost, string][] = [
      ["missing identity", stamped(undefined), "build-identity"],
      ["empty identity", stamped(""), "build-identity"],
      ["malformed identity", stamped("<b>"), "build-identity"],
      ["unsupported protocol", stamped("a1", { "data-strata-protocol": "3" }), "protocol"],
      ["missing protocol", stamped("a1", { "data-strata-protocol": undefined }), "metadata"],
      ["invalid props", stamped("a1", { "data-strata-props": "{" }), "props"],
      ["unknown prop", stamped("a1", { "data-strata-props": '{"nope":1}' }), "inputs"],
      [
        "missing reference",
        new FakeHost("relay-ghost", {
          "data-strata-client": "relay-ghost",
          "data-strata-protocol": "1",
          "data-strata-props": "{}",
          "data-strata-build": "a1",
        }),
        "reference",
      ],
    ];

    for (const [label, host, category] of cases) {
      const failure = planFailure([host], "a1");

      expect(failure, label).toBeDefined();
      expect(failure, label).not.toBeInstanceOf(StrataBuildMismatchError);
      expect(failure?.category, label).toBe(category);
    }
  });

  it("refuses the whole host on one mismatched boundary and plans nothing", () => {
    const failure = planFailure([stamped("a1"), stamped("b2")], "a1");

    expect(failure).toBeInstanceOf(StrataBuildMismatchError);
    expect(failure?.message).toContain("boundary 2 of 2");
  });

  it("does not echo a malformed attribute value", () => {
    expect(planFailure([stamped("<img src=x onerror=1>")], "a1")?.message).not.toContain("onerror");
  });
});

describe("BOUNDARY_HOST_SELECTOR", () => {
  it("finds a host by any one boundary attribute, so a partial boundary is validated", () => {
    expect(BOUNDARY_HOST_SELECTOR).toBe(
      "[data-strata-client], [data-strata-protocol], [data-strata-props]",
    );
  });
});
