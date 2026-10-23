import { describe, expect, it } from "vitest";

import {
  aotIntegrityMessage,
  countUnlinkedPartialDeclarations,
  findUncompiledAngularClasses,
  inspectCompiledModule,
} from "./aot-integrity.js";

/** What Angular's AOT emits: the decorator is gone and the definition is static. */
const AOT = `import { ɵɵdefineComponent } from "@angular/core";
import * as i0 from "@angular/core";
let ProductPage = class ProductPage {};
ProductPage.ɵfac = function ProductPage_Factory(t) { return new (t || ProductPage)(); };
ProductPage.ɵcmp = i0.ɵɵdefineComponent({ type: ProductPage, selectors: [["app-product-page"]] });
export default ProductPage;`;

/** What esbuild/oxc emit for a file the Angular plugin skipped. */
const LOWERED = `import { Component, ChangeDetectionStrategy } from "@angular/core";
import { __decorate } from "tslib";
let ProductPage = class ProductPage {};
ProductPage = __decorate([Component({ selector: "app-product-page", template: "<main></main>" })], ProductPage);
export default ProductPage;`;

describe("findUncompiledAngularClasses", () => {
  it("accepts AOT output", () => {
    expect(findUncompiledAngularClasses(AOT, "page.js")).toEqual([]);
  });

  it("finds a decorator lowered to __decorate, with its class", () => {
    expect(findUncompiledAngularClasses(LOWERED, "page.js")).toEqual([
      { decorator: "Component", className: "ProductPage" },
    ]);
  });

  it("finds decorator syntax kept as written (TypeScript)", () => {
    const code = `import { Injectable } from "@angular/core";\n@Injectable({ providedIn: "root" })\nexport class Repo {}`;

    expect(findUncompiledAngularClasses(code, "repo.ts")).toEqual([
      { decorator: "Injectable", className: "Repo" },
    ]);
  });

  it("resolves aliases and namespace imports to the Angular decorator", () => {
    const aliased = `import { Component as C } from "@angular/core";\nX = __decorate([C({})], X);`;
    const namespaced = `import * as ng from "@angular/core";\nX = __decorate([ng.Directive({})], X);`;

    expect(findUncompiledAngularClasses(aliased, "a.js")[0]?.decorator).toBe("Component");
    expect(findUncompiledAngularClasses(namespaced, "a.js")[0]?.decorator).toBe("Directive");
  });

  it("ignores a same-named decorator that is not Angular's", () => {
    const code = `import { Component } from "./my-framework";\nimport { NgZone } from "@angular/core";\nX = __decorate([Component({})], X);`;

    expect(findUncompiledAngularClasses(code, "a.js")).toEqual([]);
  });

  it("ignores decorators Angular leaves to the runtime, and a bare call", () => {
    const code = `import { Component, Input } from "@angular/core";\nX = __decorate([Input()], X.prototype, "a", void 0);\nComponent({});`;

    expect(findUncompiledAngularClasses(code, "a.js")).toEqual([]);
  });

  it("does not trust a mention in a string or comment", () => {
    const code = `import { Component } from "@angular/core";\n// __decorate([Component({})], X)\nexport const text = "__decorate([Component({})], X)";`;

    expect(findUncompiledAngularClasses(code, "a.js")).toEqual([]);
  });
});

describe("countUnlinkedPartialDeclarations", () => {
  it("counts partial declaration calls", () => {
    const code = `i0.ɵɵngDeclareComponent({ minVersion: "14.0.0", version: "22.1.7", ngImport: i0 });\ni0.ɵɵngDeclareFactory({ minVersion: "12.0.0" });`;

    expect(countUnlinkedPartialDeclarations(code)).toBe(2);
  });

  it("is not fooled by Angular's own declaration of the function", () => {
    const code = `function ɵɵngDeclareComponent(decl) { return getCompilerFacade(); }\nexport { ɵɵngDeclareComponent };`;

    expect(countUnlinkedPartialDeclarations(code)).toBe(0);
  });
});

describe("inspectCompiledModule and the diagnostic", () => {
  it("names the module, the environment and the class, without source text", () => {
    const finding = inspectCompiledModule(LOWERED, "page.js");

    expect(finding?.kind).toBe("uncompiled");

    const message = aotIntegrityMessage("src/app/pages/product.page.ts", "ssr", finding!);

    expect(message).toContain('"src/app/pages/product.page.ts" (ssr build)');
    expect(message).toContain("@Component ProductPage");
    expect(message).toContain("JIT compiler unavailable");
    expect(message).not.toContain("<main>");
    expect(message).not.toContain("/Users/");
  });

  it("reports an unlinked package separately", () => {
    const finding = inspectCompiledModule(
      `i0.ɵɵngDeclareDirective({ minVersion: "14.0.0" });`,
      "node_modules/@acme/widgets/fesm2022/widgets.mjs",
    );

    expect(finding).toEqual({ kind: "unlinked-partial", count: 1 });
    expect(aotIntegrityMessage("node_modules/@acme/widgets/x.mjs", "client", finding!)).toContain(
      "Angular linker did not process this package",
    );
  });

  it("passes a compiled module", () => {
    expect(inspectCompiledModule(AOT, "page.js")).toBeUndefined();
  });
});
