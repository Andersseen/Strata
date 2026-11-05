import { describe, expect, it } from "vitest";

import { bodyDifference, classifyReply } from "./lib/response-classification.ts";

const page = (build: string, tail = ""): string =>
  `<!DOCTYPE html><html><body><product-details data-strata-build="${build}"><h1>Product 42</h1>${tail}</product-details></body></html>`;
const expectation = (body: string) => ({
  target: "/products/42?request=c1",
  status: 200,
  contentType: "text/html",
  subject: null,
  correlation: null,
  body,
});
const reply = (body: string) => ({
  status: 200,
  headers: new Headers({ "content-type": "text/html" }),
  body,
});
const noLeaks = (): string[] => [];

describe("body-difference diagnostics of an anomaly sample", () => {
  it("locates the first difference and names the build stamps on both sides", () => {
    const result = classifyReply(expectation(page("a")), reply(page("b")), 3, noLeaks);

    expect(result.class).toBe("unclassified");
    expect(result.sample?.detail).toBe("body differs from baseline");
    expect(result.sample?.bodyDifference).toMatchObject({
      expectedBuilds: ["a"],
      actualBuilds: ["b"],
      offset: page("a").indexOf('a"'),
    });
    expect(result.sample?.bodyDifference?.actualWindow).toContain('data-strata-build="b"');
  });

  it("is bounded and also reports a pure length difference", () => {
    const difference = bodyDifference(page("a"), page("a", "x".repeat(10_000)));

    expect(difference.actualWindow.length).toBeLessThanOrEqual(80);
    expect(difference.actualLength - difference.expectedLength).toBe(10_000);
    expect(difference.expectedBuilds).toEqual(difference.actualBuilds);
  });

  it("copies nothing when either body carries a private value", () => {
    const leaks = (text: string): string[] => (text.includes("SECRET") ? ["SECRET"] : []);

    expect(
      classifyReply(expectation(page("a")), reply(page("a", "SECRET")), 1, leaks).sample
        ?.bodyDifference,
    ).toBeUndefined();
    expect(
      classifyReply(expectation(page("a", "SECRET")), reply(page("a")), 1, leaks).sample
        ?.bodyDifference,
    ).toBeUndefined();
  });

  it("adds nothing to a match", () => {
    expect(classifyReply(expectation(page("a")), reply(page("a")), 1, noLeaks)).toEqual({
      class: "match",
    });
  });
});
