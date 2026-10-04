import type { Type } from "@angular/core";
import { describe, expect, it } from "vitest";

import { StrataBoundaryError } from "./boundary-protocol.js";
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

/** As built from `reflectComponentType`: propName → public templateName. */
const references = new Map<string, ClientReference>([
  [
    "relay-triage",
    {
      type: Triage as Type<unknown>,
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
      type: Window as Type<unknown>,
      selector: "relay-window",
      // `readonly caption = input.required<string>({ alias: "label" })`
      inputs: new Map([["caption", "label"]]),
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
      'data-strata-protocol="999" is not supported',
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
      "unsupported nested value",
      boundary("relay-triage", '{"incidentId":{"id":1}}'),
      'prop "incidentId": a nested object is not supported',
    ],
    [
      "unknown input",
      boundary("relay-triage", '{"doesNotExist":1}'),
      'prop "doesNotExist" is not an input of the component',
    ],
    [
      "selector mismatch (attribute vs host element)",
      boundary("relay-window", "{}", { "data-strata-client": "relay-triage" }),
      'data-strata-client="relay-triage" does not name its host element <relay-window>',
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
});

describe("BOUNDARY_HOST_SELECTOR", () => {
  it("finds a host by any one boundary attribute, so a partial boundary is validated", () => {
    expect(BOUNDARY_HOST_SELECTOR).toBe(
      "[data-strata-client], [data-strata-protocol], [data-strata-props]",
    );
  });
});
