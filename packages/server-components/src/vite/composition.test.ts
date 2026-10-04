import { describe, expect, it } from "vitest";

import { analyzeServerComponent, createAnalysisCache } from "./analyze.js";
import type { ReadFile } from "./analyze.js";
import { renderSurrogate } from "./surrogate.js";

/**
 * Recursive Server Component composition over a small virtual app: unmarked
 * local components stay server-owned and are walked; `[strataClient]` stops
 * the walk and becomes a client reference of the outer surrogate.
 */

const DIR = "/app/src/app/orders";
const RUNTIME = `import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";`;

interface ComponentSource {
  readonly selector: string;
  /** `[ClassName, "./module"]` pairs, imported and listed in `imports`. */
  readonly imports?: readonly (readonly [string, string])[];
  readonly template?: string;
  readonly templateUrl?: string;
  readonly server?: boolean;
  readonly extra?: string;
  readonly body?: string;
}

function component(className: string, source: ComponentSource): string {
  const imports = source.imports ?? [];

  return [
    `import { Component, inject } from "@angular/core";`,
    RUNTIME,
    ...imports.map(([name, from]) => `import { ${name} } from "${from}";`),
    source.server ? "@ServerComponent()" : "",
    "@Component({",
    `  selector: ${JSON.stringify(source.selector)},`,
    `  imports: [${[...imports.map(([name]) => name), "StrataClientBoundary"].join(", ")}],`,
    source.templateUrl === undefined
      ? `  template: \`${source.template ?? ""}\`,`
      : `  templateUrl: ${JSON.stringify(source.templateUrl)},`,
    source.extra ?? "",
    "})",
    `export class ${className} {${source.body ?? ""}}`,
  ].join("\n");
}

const CLIENT_A = component("ClientA", {
  selector: "client-a",
  // Interaction inside a client component is its own business: never inspected.
  template: `<button (click)="inc()">+</button><input [(ngModel)]="value" />`,
  imports: [["ServerOnlyHelper", "./server-only.helper"]],
});

const BASE: Record<string, string> = {
  [`${DIR}/client-a.ts`]: CLIENT_A,
  [`${DIR}/client-b.ts`]: component("ClientB", {
    selector: "client-b",
    template: `<button (click)="go()">go</button>`,
  }),
  [`${DIR}/money.pipe.ts`]: `@Pipe({ name: "money" }) export class MoneyPipe {}`,
};

function app(files: Record<string, string>): { readFile: ReadFile; reads: string[] } {
  const all = { ...BASE, ...files };
  const reads: string[] = [];

  return {
    reads,
    readFile: (path) => {
      reads.push(path);
      const text = all[path];

      if (text === undefined) throw new Error(`ENOENT: ${path}`);

      return text;
    },
  };
}

/** Analyzes `${DIR}/page.ts` (or `entry`) in a virtual app. */
function analyze(files: Record<string, string>, entry = `${DIR}/page.ts`) {
  const { readFile } = app(files);

  return analyzeServerComponent(entry, readFile(entry), readFile);
}

const names = (files: Record<string, string>, entry?: string): string[] | undefined =>
  analyze(files, entry)?.clientReferences.map((ref) => ref.name);

const page = (template: string, imports: readonly (readonly [string, string])[]): string =>
  component("OrderPage", { selector: "order-page", server: true, template, imports });

const child = (
  className: string,
  selector: string,
  template: string,
  imports: readonly (readonly [string, string])[] = [],
  extra: Partial<ComponentSource> = {},
): string => component(className, { selector, template, imports, ...extra });

describe("Server Component composition: transitive client-boundary discovery", () => {
  it("collects a boundary marked directly in the server component", () => {
    expect(
      analyze({
        [`${DIR}/page.ts`]: page(`<client-a [strataClient]="{ n: 1 }" />`, [
          ["ClientA", "./client-a"],
        ]),
      }),
    ).toEqual({
      className: "OrderPage",
      selector: "order-page",
      clientReferences: [{ name: "ClientA", module: `${DIR}/client-a` }],
    });
  });

  it("walks an ordinary server child to its boundary", () => {
    expect(
      analyze({
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<h2>{{ order.name | money }}</h2><client-a [quantity]="order.quantity" [strataClient]="{ quantity: order.quantity }" />`,
          [
            ["ClientA", "./client-a"],
            ["MoneyPipe", "./money.pipe"],
          ],
        ),
      })?.clientReferences,
    ).toEqual([{ name: "ClientA", module: `${DIR}/client-a` }]);
  });

  it("walks server child → grandchild → great-grandchild to the boundary", () => {
    expect(
      names({
        [`${DIR}/page.ts`]: page(`<server-child />`, [["ServerChild", "./child"]]),
        [`${DIR}/child.ts`]: child("ServerChild", "server-child", `<server-grandchild />`, [
          ["ServerGrandchild", "./deep/grandchild"],
        ]),
        [`${DIR}/deep/grandchild.ts`]: child(
          "ServerGrandchild",
          "server-grandchild",
          `<p>deep</p><server-leaf />`,
          [["ServerLeaf", "../leaf"]],
        ),
        [`${DIR}/leaf.ts`]: child("ServerLeaf", "server-leaf", `<client-b [strataClient]="{}" />`, [
          ["ClientB", "./client-b"],
        ]),
      }),
    ).toEqual(["ClientB"]);
  });

  it("walks a nested @ServerComponent, which still analyzes on its own", () => {
    const files = {
      [`${DIR}/page.ts`]: page(`<nested-server />`, [["NestedServer", "./nested"]]),
      [`${DIR}/nested.ts`]: component("NestedServer", {
        selector: "nested-server",
        server: true,
        template: `<client-b [strataClient]="{}" />`,
        imports: [["ClientB", "./client-b"]],
      }),
    };

    expect(names(files)).toEqual(["ClientB"]);
    // Imported directly by another page, the nested one has its own surrogate.
    expect(analyze(files, `${DIR}/nested.ts`)).toEqual({
      className: "NestedServer",
      selector: "nested-server",
      clientReferences: [{ name: "ClientB", module: `${DIR}/client-b` }],
    });
  });

  it("deduplicates a client reached through several branches, in first-encounter order", () => {
    expect(
      analyze({
        [`${DIR}/page.ts`]: page(
          `<child-a /><client-b [strataClient]="{}" /><child-b /><child-a />`,
          [
            ["ChildA", "./child-a"],
            ["ClientB", "./client-b"],
            ["ChildB", "./child-b"],
          ],
        ),
        [`${DIR}/child-a.ts`]: child(
          "ChildA",
          "child-a",
          `<client-a [strataClient]="{}" /><client-a [strataClient]="{}" />`,
          [["ClientA", "./client-a"]],
        ),
        [`${DIR}/child-b.ts`]: child(
          "ChildB",
          "child-b",
          `<client-b [strataClient]="{}" /><client-a [strataClient]="{}" />`,
          [
            ["ClientA", "./client-a"],
            ["ClientB", "./client-b"],
          ],
        ),
      })?.clientReferences,
    ).toEqual([
      { name: "ClientA", module: `${DIR}/client-a` },
      { name: "ClientB", module: `${DIR}/client-b` },
    ]);
  });

  it.each([
    ["@if", `@if (open) { <order-details /> } @else { <p>closed</p> }`],
    ["@for", `@for (o of orders; track o.id) { <order-details /> }`],
    ["@empty", `@for (o of orders; track o.id) { <p>{{ o.id }}</p> } @empty { <order-details /> }`],
    ["@switch", `@switch (mode) { @case ("a") { <order-details /> } @default { <p>-</p> } }`],
    [
      "@let and nested blocks",
      `@let n = 1; @if (n) { @for (o of orders; track o) { <div><order-details /></div> } }`,
    ],
  ])("walks a server child nested in %s", (_block, template) => {
    expect(
      names({
        [`${DIR}/page.ts`]: page(template, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<client-a [strataClient]="{}" />`,
          [["ClientA", "./client-a"]],
        ),
      }),
    ).toEqual(["ClientA"]);
  });

  it("walks a server child whose template is a relative templateUrl", () => {
    expect(
      names({
        [`${DIR}/page.ts`]: page(`<order-details />`, [
          ["OrderDetails", "./details/order-details"],
        ]),
        [`${DIR}/details/order-details.ts`]: child("OrderDetails", "order-details", "", [
          ["ClientA", "../client-a"],
        ]).replace("template: ``,", 'templateUrl: "./order-details.html",'),
        [`${DIR}/details/order-details.html`]: `<ul>@for (l of lines; track l) {<li><client-a [strataClient]="{ id: l }" /></li>}</ul>`,
      }),
    ).toEqual(["ClientA"]);
  });

  it("stops at a boundary: the client component's own template is never read", () => {
    const { readFile, reads } = app({
      [`${DIR}/page.ts`]: page(`<client-a [strataClient]="{}" />`, [["ClientA", "./client-a"]]),
    });

    analyzeServerComponent(`${DIR}/page.ts`, readFile(`${DIR}/page.ts`), readFile);
    // client-a.ts is read for its selector; its imports (a server-only helper
    // that does not even exist here) and template are never followed.
    expect(reads).toEqual([`${DIR}/page.ts`, `${DIR}/client-a.ts`]);
  });

  it("keeps package components opaque: never crawled", () => {
    const { readFile, reads } = app({
      [`${DIR}/page.ts`]: `import { VoltCard } from "@voltui/components";\n${page(
        `<volt-card><client-a [strataClient]="{}" /></volt-card>`,
        [["ClientA", "./client-a"]],
      ).replace("imports: [", "imports: [VoltCard, ")}`,
    });

    expect(
      analyzeServerComponent(`${DIR}/page.ts`, readFile(`${DIR}/page.ts`), readFile)
        ?.clientReferences,
    ).toEqual([{ name: "ClientA", module: `${DIR}/client-a` }]);
    expect(reads.some((path) => path.includes("voltui"))).toBe(false);
  });

  it("allows rendering-only Angular features in server-owned templates", () => {
    expect(
      names({
        [`${DIR}/page.ts`]: page(
          `<order-details [value]="x" [attr.data-id]="id" [class.on]="on" />{{ total | money }}`,
          [
            ["OrderDetails", "./order-details"],
            ["MoneyPipe", "./money.pipe"],
          ],
        ),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<input [value]="v" disabled /><p [style.color]="c">{{ v }}</p>`,
        ),
      }),
    ).toEqual([]);
  });

  it("parses each module once per cache, across server components", () => {
    const shared = child("Shared", "shared-part", `<client-a [strataClient]="{}" />`, [
      ["ClientA", "./client-a"],
    ]);
    const { readFile, reads } = app({
      [`${DIR}/one.ts`]: component("One", {
        selector: "one-page",
        server: true,
        template: `<shared-part /><shared-part />`,
        imports: [["Shared", "./shared"]],
      }),
      [`${DIR}/two.ts`]: component("Two", {
        selector: "two-page",
        server: true,
        template: `<shared-part />`,
        imports: [["Shared", "./shared"]],
      }),
      [`${DIR}/shared.ts`]: shared,
    });
    const cache = createAnalysisCache();

    for (const entry of [`${DIR}/one.ts`, `${DIR}/two.ts`]) {
      expect(
        analyzeServerComponent(entry, readFile(entry), readFile, cache)?.clientReferences,
      ).toEqual([{ name: "ClientA", module: `${DIR}/client-a` }]);
    }

    expect(reads.filter((path) => path.endsWith("/shared.ts"))).toHaveLength(1);
    expect(reads.filter((path) => path.endsWith("/client-a.ts"))).toHaveLength(1);
  });
});

describe("Server Component composition: fails closed", () => {
  const expectFailure = (files: Record<string, string>, ...messages: string[]): void => {
    let error: unknown;

    try {
      analyze(files);
    } catch (caught) {
      error = caught;
    }

    expect(error, "the analysis must fail").toBeInstanceOf(Error);
    for (const message of messages) expect((error as Error).message).toContain(message);
  };

  it("rejects a composition cycle with the component path", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child("OrderDetails", "order-details", `<order-page />`, [
          ["OrderPage", "./page"],
        ]),
      },
      `${DIR}/order-details.ts: Server Component composition cycle: OrderPage → OrderDetails → OrderPage`,
    );
  });

  it("rejects a longer cycle below the root", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<part-a />`, [["PartA", "./a"]]),
        [`${DIR}/a.ts`]: child("PartA", "part-a", `<part-b />`, [["PartB", "./b"]]),
        [`${DIR}/b.ts`]: child("PartB", "part-b", `<part-a />`, [["PartA", "./a"]]),
      },
      "composition cycle: OrderPage → PartA → PartB → PartA",
    );
  });

  it("rejects two local imports with the same element selector", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [
          ["OrderDetails", "./order-details"],
          ["LegacyDetails", "./legacy-details"],
        ]),
        [`${DIR}/order-details.ts`]: child("OrderDetails", "order-details", ""),
        [`${DIR}/legacy-details.ts`]: child("LegacyDetails", "order-details", ""),
      },
      `${DIR}/page.ts: <order-details> is ambiguous in OrderPage: both OrderDetails (${DIR}/order-details.ts) and LegacyDetails (${DIR}/legacy-details.ts)`,
    );
  });

  it("rejects two different client components hydrating as the same element", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<child-a /><child-b />`, [
          ["ChildA", "./child-a"],
          ["ChildB", "./child-b"],
        ]),
        [`${DIR}/child-a.ts`]: child("ChildA", "child-a", `<client-a [strataClient]="{}" />`, [
          ["ClientA", "./client-a"],
        ]),
        [`${DIR}/child-b.ts`]: child("ChildB", "child-b", `<client-a [strataClient]="{}" />`, [
          ["ClientA", "./other/client-a"],
        ]),
        [`${DIR}/other/client-a.ts`]: child("ClientA", "client-a", ""),
      },
      "two client components hydrate as <client-a> under OrderPage",
    );
  });

  it("rejects a marked boundary in a server child that resolves to no local component", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<quantity-picker [strataClient]="{}" />`,
        ),
      },
      `${DIR}/order-details.ts: <quantity-picker> is marked [strataClient], but no component`,
    );
  });

  it("rejects a @ServerComponent marked as a client boundary", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<nested-server [strataClient]="{}" />`, [
          ["NestedServer", "./nested"],
        ]),
        [`${DIR}/nested.ts`]: component("NestedServer", {
          selector: "nested-server",
          server: true,
          template: "",
        }),
      },
      "NestedServer is a @ServerComponent(). A server component cannot be a client boundary.",
    );
  });

  it("rejects (click) in the root server template, with its source position", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<p>total</p>\n<button (click)="save()">Save</button>`, []),
      },
      // The template literal opens on line 7; `(click)` is on its second line.
      `${DIR}/page.ts:8:9: Interactive binding "(click)" on <button> appears in server-only component OrderPage.`,
      "Move this interaction into an Angular component marked with [strataClient].",
    );
  });

  it("rejects (click) in an ordinary server child, naming the component path", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<button (click)="save()">Save</button>`,
        ),
      },
      `${DIR}/order-details.ts:7:22: Interactive binding "(click)" on <button> appears in server-only component OrderDetails (rendered by OrderPage → OrderDetails).`,
    );
  });

  it("rejects (click) in a templateUrl, with the template file position", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child("OrderDetails", "order-details", "").replace(
          "template: ``,",
          'templateUrl: "./order-details.html",',
        ),
        [`${DIR}/order-details.html`]: `<h2>Order</h2>\n  <form (submit)="send()"></form>`,
      },
      `${DIR}/order-details.html:2:9: Interactive binding "(submit)" on <form>`,
    );
  });

  it.each([
    ["(change)", `<select (change)="pick($event)"></select>`, "(change)"],
    ["(input)", `<input (input)="type($event)" />`, "(input)"],
    ["(keydown.enter)", `<input (keydown.enter)="go()" />`, "(keydown.enter)"],
    ["(window:resize)", `<div (window:resize)="fit()"></div>`, "(window:resize)"],
    ["(valueChange) next to [value]", `<input [value]="x" (valueChange)="y()" />`, "(valueChange)"],
    ["an event on ng-template", `<ng-template (ready)="go()"></ng-template>`, "(ready)"],
  ])("rejects %s in a server-owned template", (_case, template, binding) => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`@if (on) { <order-details /> }`, [
          ["OrderDetails", "./order-details"],
        ]),
        [`${DIR}/order-details.ts`]: child("OrderDetails", "order-details", template),
      },
      `Interactive binding "${binding}"`,
      "server-only component OrderDetails",
    );
  });

  it("rejects a (customOutput) binding on a component inside a server child", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<order-line (quantityChanged)="recalc($event)" />`,
          [["OrderLine", "./order-line"]],
        ),
        [`${DIR}/order-line.ts`]: child("OrderLine", "order-line", "<p>line</p>"),
      },
      'Interactive binding "(quantityChanged)" on <order-line> appears in server-only component OrderDetails',
    );
  });

  it("rejects two-way binding in a server child", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<input [(ngModel)]="note" />`,
        ),
      },
      'Two-way binding "[(ngModel)]" on <input> appears in server-only component OrderDetails',
    );
  });

  it("rejects a server-owned handler on a client boundary's output", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<client-a [strataClient]="{}" (changed)="save($event)" />`, [
          ["ClientA", "./client-a"],
        ]),
      },
      'Interactive binding "(changed)" on <client-a>',
      "<client-a> is a client boundary, but its outputs would be handled by the server-owned template.",
    );
  });

  it("rejects host listeners on a server-owned component", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child("OrderDetails", "order-details", "", [], {
          extra: `  host: { "(click)": "open()" },`,
        }),
      },
      'host listener "(click)" on server-only component OrderDetails',
    );
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child("OrderDetails", "order-details", "", [], {
          body: `\n  @HostListener("keydown") key() {}\n`,
        }),
      },
      "@HostListener on server-only component OrderDetails",
    );
  });

  it("rejects a local directive with a host listener in a server-owned component", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: page(`<p tooltip>x</p>`, [["Tooltip", "./tooltip"]]),
        [`${DIR}/tooltip.ts`]: `@Directive({ selector: "[tooltip]", host: { "(mouseenter)": "show()" } }) export class Tooltip {}`,
      },
      'host listener "(mouseenter)" on directive Tooltip',
    );
  });

  it("rejects an event on a package component's element: still server-owned", () => {
    expectFailure(
      {
        [`${DIR}/page.ts`]: `import { VoltButton } from "@voltui/components";\n${page(
          `<volt-button (click)="save()">Save</volt-button>`,
          [],
        ).replace("imports: [", "imports: [VoltButton, ")}`,
      },
      'Interactive binding "(click)" on <volt-button>',
    );
  });

  it.each([
    [
      "an NgModule",
      { [`${DIR}/shared.module.ts`]: `@NgModule({}) export class SharedModule {}` },
      ["SharedModule", "./shared.module"],
      "SharedModule is an NgModule",
    ],
    [
      "a re-export",
      { [`${DIR}/index.ts`]: `export { ClientA } from "./client-a";` },
      ["ClientA", "./index"],
      'ClientA is imported from "./index", which does not declare class ClientA',
    ],
    [
      "an attribute-selector component",
      { [`${DIR}/row.ts`]: child("Row", "tr[order-row]", "") },
      ["Row", "./row"],
      'Row has selector "tr[order-row]"',
    ],
    [
      "a computed child template",
      { [`${DIR}/row.ts`]: child("Row", "order-row", "").replace("template: ``", "template: t") },
      ["Row", "./row"],
      "Row needs a string literal template or a relative templateUrl",
    ],
  ] as const)("rejects %s under a server component", (_shape, files, [name, from], message) => {
    expectFailure({ ...files, [`${DIR}/page.ts`]: page("<order-row />", [[name, from]]) }, message);
  });
});

describe("Server Component composition: @defer ownership", () => {
  /** The analysis error message; fails the test if the analysis succeeds. */
  const failureOf = (files: Record<string, string>): string => {
    try {
      analyze(files);
    } catch (error) {
      return (error as Error).message;
    }

    throw new Error("the analysis must fail");
  };

  const ADVICE =
    "Move the deferred behaviour inside a component marked [strataClient] (its own template may use @defer and hydrate triggers, which Angular owns), or render the server content directly.";
  const ABSENT =
    "The owning component is absent from the browser graph, so Angular cannot run this defer block client-side.";

  it("rejects an ordinary @defer in the root server template, with its source position", () => {
    const message = failureOf({
      [`${DIR}/page.ts`]: page(
        `<h1>Order</h1>\n@defer (on interaction) { <p>details</p> } @placeholder { <p>…</p> }`,
        [],
      ),
    });

    expect(message).toContain(
      `${DIR}/page.ts:8:1: @defer block in server-only component OrderPage. ${ABSENT}`,
    );
    expect(message).toContain(
      "The server renders its @placeholder (if any), and no browser code can ever load the main content.",
    );
    expect(message).toContain(ADVICE);
  });

  it("rejects @defer in an ordinary server-owned child, naming the component path", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `@defer { <p>details</p> }`,
        ),
      }),
    ).toContain(
      `${DIR}/order-details.ts:7:14: @defer block in server-only component OrderDetails (rendered by OrderPage → OrderDetails).`,
    );
  });

  it("rejects @defer in a nested Server Component, through the outer one", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(`<nested-server />`, [["NestedServer", "./nested"]]),
        [`${DIR}/nested.ts`]: component("NestedServer", {
          selector: "nested-server",
          server: true,
          template: `@defer (on viewport) { <p>late</p> } @placeholder { <p>…</p> }`,
        }),
      }),
    ).toContain(
      "@defer block in server-only component NestedServer (rendered by OrderPage → NestedServer).",
    );
  });

  it("rejects hydrate triggers in a server-owned @defer: they could never complete", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(
          `@defer (hydrate on interaction; hydrate on viewport) { <p>details</p> }`,
          [],
        ),
      }),
    ).toContain(
      "The server renders its main content, but no browser code owns the block, so its hydrate triggers (hydrate on interaction, hydrate on viewport) can never complete.",
    );
  });

  it("rejects a [strataClient] boundary below a server-owned @defer: Strata would hydrate it on load", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(
          `@defer (hydrate on interaction) { <client-a [strataClient]="{}" /> }`,
          [["ClientA", "./client-a"]],
        ),
      }),
    ).toContain(
      "It contains the client boundary <client-a>. Strata hydrates every client boundary under a Server Component when the page loads, so this block's triggers (hydrate on interaction) would not be honoured.",
    );
  });

  it("rejects a boundary in a server-owned @defer's @placeholder too", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(
          `@defer (on idle) { <p>late</p> } @placeholder { <client-b [strataClient]="{}" /> }`,
          [["ClientB", "./client-b"]],
        ),
      }),
    ).toContain("It contains the client boundary <client-b>.");
  });

  it("rejects hydrate never around a client boundary: it would render twice", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `@defer (hydrate never) { <client-a [strataClient]="{}" /> }`,
          [["ClientA", "./client-a"]],
        ),
      }),
    ).toContain(
      `It contains the client boundary <client-a>. Under "hydrate never" Angular writes no hydration annotation for it, yet Strata would still hydrate it when the page loads, rendering it a second time.`,
    );
  });

  it("rejects hydrate never around server-only content: SSR depends on unverifiable config", () => {
    expect(
      failureOf({
        [`${DIR}/page.ts`]: page(`@defer (hydrate never) { <p>static</p> }`, []),
      }),
    ).toContain(
      `Whether the server renders its main content or its @placeholder under "hydrate never" depends on the application's hydration configuration, which the build cannot verify; a placeholder could never be replaced.`,
    );
  });

  it("allows @defer inside a client boundary's own template: Angular's, never inspected", () => {
    const deferredClient = component("DeferredClient", {
      selector: "deferred-client",
      template: `@defer (on interaction; hydrate on interaction) { <heavy-widget /> } @placeholder { <button>Load</button> }
        @defer (hydrate never) { <p>static</p> }`,
      imports: [["HeavyWidget", "./heavy-widget"]],
    });

    expect(
      names({
        [`${DIR}/page.ts`]: page(`<order-details />`, [["OrderDetails", "./order-details"]]),
        [`${DIR}/order-details.ts`]: child(
          "OrderDetails",
          "order-details",
          `<deferred-client [strataClient]="{ id: 1 }" />`,
          [["DeferredClient", "./deferred-client"]],
        ),
        [`${DIR}/deferred-client.ts`]: deferredClient,
      }),
    ).toEqual(["DeferredClient"]);
  });
});

describe("Server Component composition: surrogates", () => {
  const surrogateFor = (files: Record<string, string>): string => {
    const found = analyze(files);

    if (!found) throw new Error("not a server component");

    return renderSurrogate(
      {
        ...found,
        file: `${DIR}/page.ts`,
        surrogate: "/app/src/generated/server-components/orders/page.ts",
      },
      "/app",
    );
  };

  it("Parent → ServerChild → ClientA imports ClientA, not ServerChild", () => {
    const surrogate = surrogateFor({
      [`${DIR}/page.ts`]: page(`<server-child />`, [["ServerChild", "./server-child"]]),
      [`${DIR}/server-child.ts`]: child(
        "ServerChild",
        "server-child",
        `<client-a [strataClient]="{}" />`,
        [["ClientA", "./client-a"]],
      ),
    });

    expect(surrogate.match(/^import .*$/gm)).toEqual([
      'import { ChangeDetectionStrategy, Component } from "@angular/core";',
      'import { StrataIslandHost, provideClientReferences } from "@strata-sc/server-components";',
      'import { ClientA } from "../../../app/orders/client-a";',
    ]);
    expect(surrogate).toContain("providers: [provideClientReferences([ClientA])],");
    expect(surrogate).not.toMatch(/ServerChild|server-child/);
  });

  it("ParentServer → NestedServer → ClientB imports ClientB, not the nested implementation", () => {
    const surrogate = surrogateFor({
      [`${DIR}/page.ts`]: page(`<nested-server />`, [["NestedServer", "./nested"]]),
      [`${DIR}/nested.ts`]: component("NestedServer", {
        selector: "nested-server",
        server: true,
        template: `<client-b [strataClient]="{}" />`,
        imports: [["ClientB", "./client-b"]],
      }),
    });

    expect(surrogate).toContain('import { ClientB } from "../../../app/orders/client-b";');
    expect(surrogate).toContain("providers: [provideClientReferences([ClientB])],");
    expect(surrogate).not.toMatch(/NestedServer|nested/);
  });

  it("imports a client reached through several branches once", () => {
    const surrogate = surrogateFor({
      [`${DIR}/page.ts`]: page(`<child-a /><child-b />`, [
        ["ChildA", "./child-a"],
        ["ChildB", "./child-b"],
      ]),
      [`${DIR}/child-a.ts`]: child("ChildA", "child-a", `<client-a [strataClient]="{}" />`, [
        ["ClientA", "./client-a"],
      ]),
      [`${DIR}/child-b.ts`]: child("ChildB", "child-b", `<client-a [strataClient]="{}" />`, [
        ["ClientA", "./client-a"],
      ]),
    });

    expect(surrogate.match(/import \{ ClientA \}/g)).toHaveLength(1);
    expect(surrogate).toContain("providers: [provideClientReferences([ClientA])],");
  });

  it("aliases two client components that share a class name", () => {
    const surrogate = surrogateFor({
      [`${DIR}/page.ts`]: page(`<child-a /><child-b />`, [
        ["ChildA", "./child-a"],
        ["ChildB", "./child-b"],
      ]),
      [`${DIR}/child-a.ts`]: child("ChildA", "child-a", `<client-a [strataClient]="{}" />`, [
        ["ClientA", "./client-a"],
      ]),
      [`${DIR}/child-b.ts`]: child("ChildB", "child-b", `<other-client [strataClient]="{}" />`, [
        ["ClientA", "./other/client-a"],
      ]),
      [`${DIR}/other/client-a.ts`]: child("ClientA", "other-client", ""),
    });

    expect(surrogate).toContain('import { ClientA } from "../../../app/orders/client-a";');
    expect(surrogate).toContain(
      'import { ClientA as ClientA$2 } from "../../../app/orders/other/client-a";',
    );
    expect(surrogate).toContain("providers: [provideClientReferences([ClientA, ClientA$2])],");
  });
});
