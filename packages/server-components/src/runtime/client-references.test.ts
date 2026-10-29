import "@angular/compiler";
import { Component, Directive, Input } from "@angular/core";
import { describe, expect, it } from "vitest";

import { StrataBoundaryError } from "./boundary-protocol.js";
import { buildClientReferenceRegistry } from "./client-references.js";
import { planClientBoundaries } from "./hydration-plan.js";
import type { BoundaryHost } from "./hydration-plan.js";

@Component({ selector: "product-picker", template: "" })
class ProductPicker {
  @Input({ alias: "productSku" }) sku = "";
}

@Component({ selector: "quantity-picker", template: "" })
class QuantityPicker {}

@Component({ selector: "product-picker", template: "" })
class RivalPicker {}

@Directive({ selector: "[highlight]" })
class Highlight {}

class NotAComponent {}

const host = (localName: string): BoundaryHost => ({
  localName,
  getAttribute: (name) =>
    ({ "data-strata-client": localName, "data-strata-protocol": "1", "data-strata-props": "{}" })[
      name
    ] ?? null,
});

describe("buildClientReferenceRegistry (real Angular component metadata)", () => {
  it("registers a valid component by its reflected selector, with public input names", () => {
    const registry = buildClientReferenceRegistry([ProductPicker]);

    expect(registry.problem).toBeUndefined();
    expect(registry.references.get("product-picker")?.type).toBe(ProductPicker);
    expect(registry.references.get("product-picker")?.inputs.get("sku")).toBe("productSku");
  });

  it("keeps distinct components with distinct selectors", () => {
    const registry = buildClientReferenceRegistry([ProductPicker, QuantityPicker]);

    expect(registry.problem).toBeUndefined();
    expect([...registry.references.keys()]).toEqual(["product-picker", "quantity-picker"]);
  });

  it("accepts the same component referenced twice", () => {
    expect(buildClientReferenceRegistry([ProductPicker, ProductPicker]).problem).toBeUndefined();
    expect(
      buildClientReferenceRegistry([
        ProductPicker,
        { type: ProductPicker, expectedSelector: "product-picker" },
      ]).problem,
    ).toBeUndefined();
  });

  it("accepts a descriptor whose expected selector equals the actual one", () => {
    const registry = buildClientReferenceRegistry([
      { type: ProductPicker, expectedSelector: "product-picker" },
    ]);

    expect(registry.problem).toBeUndefined();
    expect(registry.references.size).toBe(1);
  });

  // Regression: the original Map construction kept the last of two distinct
  // types claiming one selector, silently.
  it("reports two distinct components claiming one selector instead of overwriting", () => {
    const registry = buildClientReferenceRegistry([ProductPicker, RivalPicker]);

    expect(registry.problem).toMatch(/two different components declare selector "product-picker"/);
  });

  it("reports an expected selector that differs from the actual one", () => {
    const registry = buildClientReferenceRegistry([
      { type: ProductPicker, expectedSelector: "acme-product-picker" },
    ]);

    expect(registry.problem).toMatch(
      /registered for <acme-product-picker> but its component declares selector "product-picker"/,
    );
  });

  it("reports a directive, a plain class and a non-function as missing component metadata", () => {
    for (const bad of [Highlight, NotAComponent, 5 as never]) {
      expect(buildClientReferenceRegistry([bad]).problem).toMatch(/not an Angular component/);
    }
  });

  it("reports an empty object as a malformed descriptor", () => {
    expect(buildClientReferenceRegistry([{} as never]).problem).toMatch(/not a valid descriptor/);
  });

  it("reports an invalid reference beside valid ones", () => {
    const registry = buildClientReferenceRegistry([ProductPicker, NotAComponent, QuantityPicker]);

    expect(registry.problem).toMatch(/client reference 2 of 3/);
  });

  it("never prints the class name or any consumer value", () => {
    const problem = buildClientReferenceRegistry([NotAComponent]).problem;

    expect(problem).not.toContain("NotAComponent");
  });
});

const CANARY = "CANARY-private-getter-value";

describe("buildClientReferenceRegistry malformed descriptors (fail closed)", () => {
  const problemOf = (input: unknown): string | undefined =>
    buildClientReferenceRegistry([input as never]).problem;

  it("A: a throwing type getter becomes a reference problem", () => {
    const descriptor = {
      get type(): never {
        throw new Error(CANARY);
      },
      expectedSelector: "product-picker",
    };

    expect(() => buildClientReferenceRegistry([descriptor as never])).not.toThrow();
    expect(problemOf(descriptor)).toMatch(/client reference 1 of 1/);
    expect(problemOf(descriptor)).not.toContain(CANARY);
  });

  it("B: a throwing expectedSelector getter becomes a reference problem", () => {
    const descriptor = {
      type: ProductPicker,
      get expectedSelector(): never {
        throw new Error(CANARY);
      },
    };

    expect(() => buildClientReferenceRegistry([descriptor as never])).not.toThrow();
    expect(problemOf(descriptor)).toBeDefined();
    expect(problemOf(descriptor)).not.toContain(CANARY);
  });

  it.each([
    ["C: a number", 42],
    ["D: null", null],
    ["E: an empty string", ""],
    ["F: a malformed selector", "Not A Selector"],
    ["F: a selector without a hyphen", "picker"],
    ["an object", { toString: () => CANARY }],
    ["undefined (descriptor missing the key)", undefined],
  ])("rejects expectedSelector %s", (_label, expectedSelector) => {
    const problem = problemOf({ type: ProductPicker, expectedSelector });

    expect(problem).toBeDefined();
    expect(problem).not.toContain(CANARY);
  });

  it("G: Angular reflection that throws becomes a reference problem", () => {
    const hostile = new Proxy(class {}, {
      get() {
        throw new Error(CANARY);
      },
      getOwnPropertyDescriptor() {
        throw new Error(CANARY);
      },
    });

    expect(() => buildClientReferenceRegistry([hostile as never])).not.toThrow();
    expect(problemOf(hostile)).toMatch(/client reference 1 of 1/);
    expect(problemOf(hostile)).not.toContain(CANARY);
  });

  it("H: a valid reference after an invalid one is not registered as trusted", () => {
    const registry = buildClientReferenceRegistry([
      { type: ProductPicker, expectedSelector: 7 as never },
      QuantityPicker,
    ]);

    expect(registry.problem).toMatch(/client reference 1 of 2/);
  });

  it("I: a valid component with a different actual selector is refused", () => {
    expect(problemOf({ type: QuantityPicker, expectedSelector: "product-picker" })).toMatch(
      /registered for <product-picker>/,
    );
  });

  it("J: two distinct components with one selector are refused, as descriptors too", () => {
    expect(
      buildClientReferenceRegistry([
        { type: ProductPicker, expectedSelector: "product-picker" },
        { type: RivalPicker, expectedSelector: "product-picker" },
      ]).problem,
    ).toMatch(/two different components declare selector "product-picker"/);
  });

  it("refuses a registry that is not an array, or an array whose element access throws", () => {
    expect(buildClientReferenceRegistry(undefined as never).problem).toMatch(/not an array/);
    expect(buildClientReferenceRegistry({ length: 1 } as never).problem).toMatch(/not an array/);

    const hostile = new Proxy([ProductPicker], {
      get(target, key, receiver) {
        if (key === "0") throw new Error(CANARY);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const registry = buildClientReferenceRegistry(hostile);

    expect(registry.problem).toMatch(/client reference 1 of 1 could not be read/);
    expect(registry.problem).not.toContain(CANARY);
  });

  it("does not run consumer toString, valueOf or inherited accessors", () => {
    let calls = 0;
    const prototype = {
      get type() {
        calls++;
        return ProductPicker;
      },
      get expectedSelector() {
        calls++;
        return "product-picker";
      },
    };
    const descriptor = Object.create(prototype) as object;

    // Inherited (non-own) properties are not a valid descriptor.
    expect(problemOf(descriptor)).toBeDefined();
    expect(calls).toBe(0);
  });
});

describe("planClientBoundaries with a registry problem", () => {
  const registry = buildClientReferenceRegistry([ProductPicker, RivalPicker]);

  it("refuses every boundary as a reference failure, before creating anything", () => {
    expect(() =>
      planClientBoundaries(
        "page-host",
        [host("product-picker")],
        registry.references,
        undefined,
        registry.problem,
      ),
    ).toThrowError(
      expect.objectContaining({ category: "reference", name: StrataBoundaryError.name }),
    );
  });

  it("does not refuse a host with no boundaries", () => {
    expect(
      planClientBoundaries("page-host", [], registry.references, undefined, registry.problem),
    ).toEqual([]);
  });

  it("plans normally with a healthy registry", () => {
    const healthy = buildClientReferenceRegistry([ProductPicker]);

    expect(
      planClientBoundaries(
        "page-host",
        [host("product-picker")],
        healthy.references,
        undefined,
        healthy.problem,
      ),
    ).toHaveLength(1);
  });
});
