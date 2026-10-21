import "@angular/compiler";
import { APP_BASE_HREF, DOCUMENT, Location, PlatformLocation } from "@angular/common";
import { MockPlatformLocation } from "@angular/common/testing";
import type { EnvironmentInjector } from "@angular/core";
import { createEnvironmentInjector, Injector, ɵConsole, ɵINJECTOR_SCOPE } from "@angular/core";
import { provideRouter, Router, UrlSerializer } from "@angular/router";
import { describe, expect, it } from "vitest";

import { StrataDocumentNavigationError, resolveDocumentUrl } from "./resolve.js";

function setup(baseHref = "/") {
  const injector = createEnvironmentInjector(
    [
      { provide: ɵINJECTOR_SCOPE, useValue: "root" },
      { provide: ɵConsole, useClass: ɵConsole },
      { provide: DOCUMENT, useValue: { title: "", defaultView: null } },
      provideRouter([]),
      { provide: APP_BASE_HREF, useValue: baseHref },
      { provide: PlatformLocation, useClass: MockPlatformLocation },
    ],
    Injector.NULL as EnvironmentInjector,
  );
  return {
    router: injector.get(Router),
    location: injector.get(Location),
    serializer: injector.get(UrlSerializer),
  };
}

const resolve = (
  destination: Parameters<typeof resolveDocumentUrl>[1],
  extras?: Parameters<typeof resolveDocumentUrl>[2],
  baseHref = "/",
) => {
  return resolveDocumentUrl(setup(baseHref), destination, extras);
};

describe("resolveDocumentUrl", () => {
  it("resolves root-relative command arrays", () => {
    expect(resolve(["/products", 42])).toBe("/products/42");
    expect(resolve(["/products", "a", "b"])).toBe("/products/a/b");
  });

  it("serializes query parameters and fragments", () => {
    expect(
      resolve(["/p", 1], { queryParams: { tab: "variants", n: 2 }, fragment: "details" }),
    ).toBe("/p/1?tab=variants&n=2#details");
    expect(resolve(["/p"], { queryParams: { q: ["a", "b"] } })).toBe("/p?q=a&q=b");
  });

  it("percent-encodes unicode and separators inside one segment", () => {
    expect(resolve(["/p", "naïve café"])).toBe("/p/na%C3%AFve%20caf%C3%A9");
    expect(resolve(["/p", "a/b"])).toBe("/p/a%2Fb");
    expect(resolve(["/p", "a?b#c"])).toBe("/p/a%3Fb%23c");
    expect(resolve(["/p"], { queryParams: { q: "a&b=c d" } })).toBe("/p?q=a%26b%3Dc%20d");
  });

  it("applies the base href", () => {
    expect(resolve(["/products", 1], { fragment: "x" }, "/app/")).toBe("/app/products/1#x");
    expect(resolve("/products?tab=1", undefined, "/app/")).toBe("/app/products?tab=1");
  });

  it("accepts root-relative strings with query and fragment", () => {
    expect(resolve("/products/42?tab=v#details")).toBe("/products/42?tab=v#details");
    expect(resolve("/")).toBe("/");
  });

  it("accepts a UrlTree", () => {
    const context = setup("/app/");

    expect(resolveDocumentUrl(context, context.router.parseUrl("/products/1?tab=x#f"))).toBe(
      "/app/products/1?tab=x#f",
    );
  });

  it("does not let an empty first segment become protocol-relative", () => {
    expect(resolve(["//evil.example", "x"])).toBe("/evil.example/x");
  });

  it.each([
    "https://evil.example/x",
    "//evil.example/x",
    "javascript:alert(1)",
    "data:text/html,x",
    "JaVaScRiPt:alert(1)",
    "products/42",
    "?tab=1",
    "#frag",
    "",
    "/ok\\evil",
    "/a\u0000b",
    "/a\nb",
  ])("rejects the unsafe or non-root-relative string %j", (destination) => {
    expect(() => resolve(destination)).toThrow(StrataDocumentNavigationError);
  });

  it("rejects schemes and control characters in commands", () => {
    expect(() => resolve(["javascript:alert(1)"])).toThrow(StrataDocumentNavigationError);
    expect(() => resolve(["/p", "https://evil.example"])).toThrow(StrataDocumentNavigationError);
    expect(() => resolve(["/p\nx"])).toThrow(StrataDocumentNavigationError);
  });

  it("rejects query/fragment extras on a string destination", () => {
    expect(() => resolve("/p", { fragment: "x" })).toThrow(/cannot be combined/);
  });

  it("rejects missing or malformed destinations", () => {
    expect(() => resolve(undefined as never)).toThrow(StrataDocumentNavigationError);
    expect(() => resolve(null as never)).toThrow(StrataDocumentNavigationError);
    expect(() => resolve(42 as never)).toThrow(StrataDocumentNavigationError);
    expect(() => resolve("/a/(b")).toThrow(StrataDocumentNavigationError);
  });

  it("strips the document origin Angular falls back to when the page has no <base>", () => {
    const context = { ...setup("http://app.example"), origin: "http://app.example" };

    expect(resolveDocumentUrl(context, ["/p", 1], { fragment: "x" })).toBe("/p/1#x");
    expect(resolveDocumentUrl(context, "/")).toBe("/");
  });

  it("rejects a base href on another origin", () => {
    const context = { ...setup("https://cdn.example/"), origin: "http://app.example" };

    expect(() => resolveDocumentUrl(context, ["/p"])).toThrow(/same-origin path/);
  });

  it("rejects an absolute or protocol-relative base href", () => {
    expect(() => resolve(["/p"], undefined, "https://cdn.example/")).toThrow(/same-origin path/);
  });

  it("never echoes query parameters in errors", () => {
    const secret = "s3cr3t-token";

    try {
      resolve("//evil.example", { queryParams: { token: secret } });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    try {
      resolve(`https://evil.example/?token=${secret}`);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});
