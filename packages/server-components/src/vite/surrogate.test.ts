import { describe, expect, it } from "vitest";

import { renderSurrogate } from "./surrogate.js";

const surrogate = renderSurrogate(
  {
    file: "/app/src/app/orders/order-summary.component.ts",
    surrogate: "/app/src/generated/server-components/orders/order-summary.component.ts",
    className: "OrderSummaryComponent",
    selector: "order-summary",
    clientReferences: [
      { name: "QuantityPicker", module: "/app/src/app/orders/quantity-picker.component" },
      { name: "RatingStars", module: "@acme/widgets" },
    ],
  },
  "/app",
);

describe("renderSurrogate", () => {
  it("keeps the class name and selector, with an empty browser template", () => {
    expect(surrogate).toContain("export class OrderSummaryComponent {}");
    expect(surrogate).toContain('selector: "order-summary",');
    expect(surrogate).toContain('template: "",');
  });

  it("hosts StrataIslandHost, imported from the runtime package", () => {
    expect(surrogate).toContain(
      'import { StrataIslandHost, provideClientReferences } from "@strata-sc/server-components";',
    );
    expect(surrogate).toContain("hostDirectives: [StrataIslandHost],");
  });

  it("imports the client references from the consumer's modules and provides them", () => {
    expect(surrogate).toContain(
      'import { QuantityPicker } from "../../../app/orders/quantity-picker.component";',
    );
    expect(surrogate).toContain('import { RatingStars } from "@acme/widgets";');
    expect(surrogate).toContain(
      "providers: [provideClientReferences([QuantityPicker, RatingStars])],",
    );
  });

  it("imports nothing else: no implementation, no server-only module", () => {
    const imports = surrogate.match(/^import .*$/gm);

    expect(imports).toEqual([
      'import { ChangeDetectionStrategy, Component } from "@angular/core";',
      'import { StrataIslandHost, provideClientReferences } from "@strata-sc/server-components";',
      'import { QuantityPicker } from "../../../app/orders/quantity-picker.component";',
      'import { RatingStars } from "@acme/widgets";',
    ]);
    expect(surrogate).not.toMatch(/order-summary\.component"|inject\(|ServerComponent\(/);
  });
});
