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

describe("Angular hydration template ids (per-isolate numbering)", () => {
  const doc = (
    ids: [string, string],
    value = "Product 42",
    tag = '<script id="ng-state" type="application/json">',
  ) =>
    `<html><body><h1>${value}</h1>${tag}{"__nghData__":[{},{"t":{"0":"${ids[0]}","1":"${ids[1]}"},"c":{"0":[{"i":"${ids[0]}","r":1}]}}]}</script></body></html>`;

  it("treats a renumbered annotation as the same document (deployed run 42034490852)", () => {
    const result = classifyReply(
      expectation(doc(["t3", "t4"])),
      reply(doc(["t0", "t1"])),
      1,
      noLeaks,
    );

    expect(result).toEqual({ class: "match" });
    expect(
      classifyReply(
        expectation(
          doc(["t3", "t4"], "Product 42", '<script type="application/json" id="ng-state">'),
        ),
        reply(doc(["t0", "t1"], "Product 42", '<script type="application/json" id="ng-state">')),
        1,
        noLeaks,
      ),
    ).toEqual({ class: "match" });
  });

  it("still detects a different id structure and any other changed byte (negative controls)", () => {
    expect(
      classifyReply(expectation(doc(["t3", "t4"])), reply(doc(["t0", "t0"])), 1, noLeaks).class,
    ).toBe("unclassified");
    expect(
      classifyReply(
        expectation(doc(["t3", "t4"])),
        reply(doc(["t0", "t1"], "Product 7")),
        1,
        noLeaks,
      ).class,
    ).toBe("unclassified");
    expect(
      classifyReply(
        expectation(doc(["t3", "t4"])),
        reply(doc(["t0", "t1"]).replace('type="application/json"', 'type="text/plain"')),
        1,
        noLeaks,
      ).class,
    ).toBe("unclassified");
  });
});

describe("concurrent-round body comparison (F5 residual, deployed run 42053087187)", async () => {
  const { bodyMatchesBaseline } = await import("./lib/full-stack-remote.ts");
  const doc = (ids: string, text = "Product 42") =>
    `<!DOCTYPE html><html><body><h1>${text}</h1><script id="ng-state" type="application/json">{"__nghData__":[{"t":{"0":"${ids}"}}]}</script></body></html>`;

  it("accepts a document whose only difference is Angular's per-isolate template ids", () => {
    expect(bodyMatchesBaseline(doc("t0"), doc("t3"), ["req-1"])).toBe(true);
  });

  it("still rejects any other difference, an echoed request id or a private canary", () => {
    expect(bodyMatchesBaseline(doc("t0"), doc("t3", "Product 7"), ["req-1"])).toBe(false);
    expect(bodyMatchesBaseline(doc("t0"), `${doc("t0")}req-1`, ["req-1"])).toBe(false);
    // Identical to its baseline, yet carrying a private canary: still rejected.
    const leaky = doc("t0", "ALPHA_CONFIDENTIAL_71c1");
    expect(bodyMatchesBaseline(leaky, leaky, ["req-1"])).toBe(false);
  });
});
