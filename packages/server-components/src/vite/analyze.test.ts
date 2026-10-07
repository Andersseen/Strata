import { describe, expect, it } from "vitest";

import { analyzeServerComponent } from "./analyze.js";
import type { ReadFile } from "./analyze.js";

const FILE = "/app/src/app/orders/order-summary.component.ts";

/** The app modules the analyzer may read, by absolute path. */
const APP_MODULES: Record<string, string> = {
  "/app/src/app/orders/quantity-picker.component.ts": `
    @Component({ selector: "quantity-picker", template: "" })
    export class QuantityPicker {}`,
  "/app/src/app/orders/order-lines.component.ts": `
    @Component({ selector: "order-lines", template: "" })
    export class OrderLines {}`,
  "/app/src/app/orders/money.pipe.ts": `
    @Pipe({ name: "money" })
    export class MoneyPipe {}`,
  "/app/src/app/orders/order-summary.component.html": `<quantity-picker [strataClient]="{}" />`,
};

const readFile: ReadFile = (path) => {
  const text = APP_MODULES[path];

  if (text === undefined) throw new Error(`ENOENT: ${path}`);

  return text;
};

function serverComponent({
  imports = "QuantityPicker, OrderLines, MoneyPipe, RatingStars, StrataClientBoundary",
  template = `\`@if (open) { <quantity-picker [strataClient]="{ max: 3 }" /> }
    <order-lines />{{ total | money }}<rating-stars />\``,
} = {}): string {
  return `
import { Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import { QuantityPicker } from "./quantity-picker.component";
import { OrderLines } from "./order-lines.component";
import { MoneyPipe } from "./money.pipe";
import { RatingStars } from "@acme/widgets";
import { OrderRepository } from "./order-repository";

@ServerComponent()
@Component({
  selector: 'order-summary',
  imports: [${imports}],
  template: ${template},
})
export class OrderSummaryComponent {
  private readonly orders = inject(OrderRepository);
}
`;
}

describe("analyzeServerComponent", () => {
  it("ignores a module without the marker", () => {
    expect(
      analyzeServerComponent(FILE, `@Component({ selector: "x" }) export class X {}`, readFile),
    ).toBeUndefined();
  });

  it("reads the class name, the selector and the explicit client boundaries", () => {
    expect(analyzeServerComponent(FILE, serverComponent(), readFile)).toEqual({
      className: "OrderSummaryComponent",
      selector: "order-summary",
      clientReferences: [
        { name: "QuantityPicker", module: "/app/src/app/orders/quantity-picker.component" },
      ],
      serverOwnedFiles: [
        "/app/src/app/orders/money.pipe.ts",
        "/app/src/app/orders/order-lines.component.ts",
        "/app/src/app/orders/order-summary.component.ts",
      ],
    });
  });

  it("keeps unmarked components, pipes, package imports and the runtime server-only", () => {
    const names = analyzeServerComponent(FILE, serverComponent(), readFile)?.clientReferences.map(
      (ref) => ref.name,
    );

    for (const serverOnly of [
      "OrderLines",
      "MoneyPipe",
      "RatingStars",
      "StrataClientBoundary",
      "OrderRepository",
    ]) {
      expect(names).not.toContain(serverOnly);
    }
  });

  it("finds a boundary repeated inside @for, nested blocks and @empty", () => {
    const source = serverComponent({
      template: `\`<ol>
        @for (line of lines; track line.id) {
          <li>@if (line.editable) {
            <quantity-picker [strataClient]="{ lineId: line.id, max: line.max }" />
          }</li>
        } @empty {
          <order-lines />
        }
      </ol>\``,
    });

    expect(analyzeServerComponent(FILE, source, readFile)?.clientReferences).toEqual([
      { name: "QuantityPicker", module: "/app/src/app/orders/quantity-picker.component" },
    ]);
  });

  it("finds boundaries in a templateUrl", () => {
    const source = serverComponent({ template: '"x"' }).replace(
      'template: "x"',
      'templateUrl: "./order-summary.component.html"',
    );

    expect(analyzeServerComponent(FILE, source, readFile)?.clientReferences).toEqual([
      { name: "QuantityPicker", module: "/app/src/app/orders/quantity-picker.component" },
    ]);
  });

  it("ignores a module that only mentions the decorator in strings or comments", () => {
    const source = [
      "// Usage: @ServerComponent() on an @Component class.",
      'export const EXAMPLE = `@ServerComponent()\n@Component({ selector: "x" })`;',
      'export const ONE_LINE = "@ServerComponent() export class Y {}";',
    ].join("\n");

    expect(analyzeServerComponent(FILE, source, readFile)).toBeUndefined();
  });

  it("has no client references when nothing is marked", () => {
    expect(
      analyzeServerComponent(FILE, serverComponent({ template: '"<quantity-picker />"' }), readFile)
        ?.clientReferences,
    ).toEqual([]);
  });

  it.each([
    [
      "two server components in one module",
      `${serverComponent()}\n@ServerComponent() @Component({ selector: "b" }) export class B {}`,
      "expected exactly one named @ServerComponent() class",
    ],
    [
      "a server component class that is not a top-level statement",
      `export function make() { @ServerComponent() @Component({ selector: "a", template: "" }) class A {} return A; }`,
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
      "a computed template",
      `const t = "a"; @ServerComponent() @Component({ selector: "a", template: t }) export class A {}`,
      "a server component needs a string literal template or templateUrl",
    ],
    [
      "a non-identifier import",
      `import * as w from "w"; @ServerComponent() @Component({ selector: "a", template: "", imports: [w.X] }) export class A {}`,
      "server component imports must be plain identifiers",
    ],
    [
      "an import with no named import binding",
      `@ServerComponent() @Component({ selector: "a", template: "", imports: [Local] }) export class A {}`,
      "cannot find the import of Local",
    ],
    [
      "a boundary on an element no relative import declares",
      serverComponent({ template: '`<rating-stars [strataClient]="{}" />`' }),
      '<rating-stars> is marked [strataClient], but no component in imports from a relative app module has selector "rating-stars".',
    ],
    [
      "an import from a module that does not declare it (a barrel)",
      serverComponent().replace('from "./money.pipe"', 'from "./order-lines.component"'),
      'MoneyPipe is imported from "./order-lines.component", which does not declare class MoneyPipe',
    ],
    [
      "a boundary on a component missing from imports",
      serverComponent({ imports: "StrataClientBoundary" }),
      "<quantity-picker> is marked [strataClient]",
    ],
  ])("rejects %s (experimental restriction)", (_shape, source, message) => {
    expect(() => analyzeServerComponent(FILE, source, readFile)).toThrow(`${FILE}: ${message}`);
  });
});
