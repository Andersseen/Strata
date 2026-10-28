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
    for (const bad of [Highlight, NotAComponent, {} as never]) {
      expect(buildClientReferenceRegistry([bad]).problem).toMatch(/not an Angular component/);
    }
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
