import { describe, expect, it } from "vitest";

import { analyzeServerComponent } from "./analyze.js";

const FILE = "/app/src/app/orders/order-summary.component.ts";

const SERVER_COMPONENT = `
import { Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import { QuantityPicker } from "./quantity-picker.component";
import { RatingStars } from "@acme/widgets";
import { OrderRepository } from "./order-repository";

@ServerComponent()
@Component({
  selector: 'order-summary',
  imports: [QuantityPicker, RatingStars, StrataClientBoundary],
  template: \`<quantity-picker [strataClient]="{ max: 3 }" />\`,
})
export class OrderSummaryComponent {
  private readonly orders = inject(OrderRepository);
}
`;

describe("analyzeServerComponent", () => {
  it("ignores a module without the marker", () => {
    expect(
      analyzeServerComponent(FILE, `@Component({ selector: "x" }) export class X {}`),
    ).toBeUndefined();
  });

  it("reads the class name, the selector and the client references", () => {
    expect(analyzeServerComponent(FILE, SERVER_COMPONENT)).toEqual({
      className: "OrderSummaryComponent",
      selector: "order-summary",
      clientReferences: [
        { name: "QuantityPicker", module: "/app/src/app/orders/quantity-picker.component" },
        { name: "RatingStars", module: "@acme/widgets" },
      ],
    });
  });

  it("never treats the runtime package or non-`imports` dependencies as client references", () => {
    const names = analyzeServerComponent(FILE, SERVER_COMPONENT)?.clientReferences.map(
      (ref) => ref.name,
    );

    expect(names).not.toContain("StrataClientBoundary");
    expect(names).not.toContain("OrderRepository");
  });

  it.each([
    [
      "two server components in one module",
      `${SERVER_COMPONENT}\n@ServerComponent() @Component({ selector: "b" }) export class B {}`,
      "expected exactly one named @ServerComponent() class",
    ],
    [
      "an anonymous class",
      `@ServerComponent() @Component({ selector: "a" }) export default class {}`,
      "expected exactly one named @ServerComponent() class",
    ],
    [
      "no @Component metadata",
      `@ServerComponent() export class A {}`,
      "@ServerComponent() must decorate an @Component({...}) class",
    ],
    [
      "a computed selector",
      `const s = "a"; @ServerComponent() @Component({ selector: s }) export class A {}`,
      "a server component needs a string literal selector",
    ],
    [
      "a non-identifier import",
      `import * as w from "w"; @ServerComponent() @Component({ selector: "a", imports: [w.X] }) export class A {}`,
      "server component imports must be plain identifiers",
    ],
    [
      "an import with no named import binding",
      `@ServerComponent() @Component({ selector: "a", imports: [Local] }) export class A {}`,
      "cannot find the import of Local",
    ],
  ])("rejects %s (experimental restriction)", (_shape, source, message) => {
    expect(() => analyzeServerComponent(FILE, source)).toThrow(`${FILE}: ${message}`);
  });
});
