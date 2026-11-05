import { describe, expect, it } from "vitest";

import { assessHydration, assessSsrDocument, describeAssessment } from "./lib/ssr-integrity.ts";
import type { SsrExpectation, SsrReply } from "./lib/ssr-integrity.ts";

/**
 * Negative controls for the SSR integrity classifier every production qualification relies on
 * (docs/research/server-component-ssr-integrity-v07.md). Angular and Analog answer an unexpected
 * render failure with HTTP 200 and an empty or partial shell, so a classifier that only looked at
 * the status would make every suite pass vacuously. These cases pin that it does not.
 */

const SERVER_TEXT = "Rendered on the server";
const PRIVATE = "STRATA_SSR_INTEGRITY_PRIVATE_CANARY";

const expectation: SsrExpectation = {
  content: { heading: "<h1>Product 42</h1>", server: SERVER_TEXT },
  boundaries: [{ selector: "add-to-cart", protocol: "2" }],
  forbidden: { canary: PRIVATE },
};

const boundary = (
  attributes = 'data-strata-protocol="2" data-strata-props="{&quot;id&quot;:&quot;42&quot;}" ngh="0"',
) =>
  `<add-to-cart data-strata-client="add-to-cart" ${attributes}><button>Add</button></add-to-cart>`;

const documentWith = (appRoot: string): string =>
  `<!doctype html><html><head><title>t</title></head><body><app-root ng-version="22.2.3">${appRoot}</app-root></body></html>`;

const complete = documentWith(
  `<router-outlet></router-outlet><product-details><article><h1>Product 42</h1><p>${SERVER_TEXT}</p>${boundary()}</article></product-details>`,
);

const reply = (body: string, status = 200, contentType = "text/html; charset=utf-8"): SsrReply => ({
  status,
  contentType,
  body,
});

const classes = (body: string, log = "", status = 200) =>
  assessSsrDocument(reply(body, status), log, expectation).findings.map((finding) => finding.class);

describe("assessSsrDocument", () => {
  it("accepts a complete document with a clean server log (positive control)", () => {
    const assessment = assessSsrDocument(reply(complete), "listening on :3000\n", expectation);

    expect(assessment.ok).toBe(true);
    expect(assessment.findings).toEqual([]);
    expect(assessment.summary.boundaries).toBe(1);
    expect(describeAssessment(assessment)).toBe("complete document, clean server log");
  });

  it("refuses an HTTP 200 empty shell as incomplete SSR, not success", () => {
    for (const shell of [
      "",
      "  ",
      "<router-outlet></router-outlet>",
      "\n<router-outlet ></router-outlet>\n",
    ]) {
      const assessment = assessSsrDocument(reply(documentWith(shell)), "", expectation);

      expect(assessment.ok).toBe(false);
      expect(assessment.summary.appRootEmpty).toBe(true);
      expect(assessment.findings.map((finding) => finding.class)).toContain("incomplete-ssr");
      // The missing island is the shell's finding, not a second, misleading one.
      expect(assessment.findings.some((finding) => finding.detail.includes("<add-to-cart>"))).toBe(
        false,
      );
    }
  });

  it("refuses a document without app-root at all", () => {
    expect(classes("<!doctype html><html><body></body></html>")).toContain("incomplete-ssr");
  });

  it("refuses a partial render (layout present, server-owned content and island missing)", () => {
    const partial = documentWith(
      "<router-outlet></router-outlet><product-details><article><h1>Product 42</h1></article></product-details>",
    );
    const assessment = assessSsrDocument(reply(partial), "", expectation);

    expect(assessment.ok).toBe(false);
    expect(assessment.summary.missing).toEqual(["server"]);
    expect(assessment.findings.map((finding) => finding.detail).join(" ")).toContain(
      "island <add-to-cart> is not in the document",
    );
  });

  it("refuses a complete-looking document when the server log reports a render or JIT error", () => {
    expect(classes(complete, "ERROR TypeError: Cannot read properties of undefined\n")).toEqual([
      "server-bootstrap",
    ]);
    expect(classes(complete, "NG0201: No provider found\n")).toEqual(["server-bootstrap"]);
    expect(classes(complete, "JIT compiler unavailable\n")).toEqual(["build-compilation"]);
  });

  it("refuses a non-200 status or a non-HTML type even when the body is complete", () => {
    expect(classes(complete, "", 500)).toEqual(["incomplete-ssr"]);
    expect(assessSsrDocument(reply(complete, 200, "application/json"), "", expectation).ok).toBe(
      false,
    );
  });

  it("refuses a boundary with the wrong protocol, invalid props or no hydration annotation", () => {
    const wrongProtocol = complete.replace('data-strata-protocol="2"', 'data-strata-protocol="1"');
    const invalidProps = complete.replace("{&quot;id&quot;:&quot;42&quot;}", "{not json");
    const noAnnotation = complete.replace(' ngh="0"', "");

    expect(classes(wrongProtocol)).toEqual(["boundary-serialization"]);
    expect(classes(invalidProps)).toEqual(["boundary-serialization"]);
    expect(classes(noAnnotation)).toEqual(["boundary-serialization"]);
  });

  it("refuses a server-only value in the document, raw or HTML-escaped inside an attribute", () => {
    const raw = complete.replace(SERVER_TEXT, `${SERVER_TEXT} ${PRIVATE}`);
    // A structured canary crosses as JSON inside data-strata-props, where every quote is &quot;.
    const structured = '{"tenant":"beta","token":"SSR_PRIVATE_TOKEN"}';
    const escaped = complete.replace(
      "{&quot;id&quot;:&quot;42&quot;}",
      structured.replaceAll('"', "&quot;"),
    );
    const numeric = complete.replace(SERVER_TEXT, `${SERVER_TEXT} a&#60;b&#x3E;c`);

    expect(classes(raw)).toEqual(["graph-confidentiality"]);
    expect(
      assessSsrDocument(reply(escaped), "", {
        ...expectation,
        forbidden: { structured },
      }).findings.map((finding) => finding.class),
    ).toEqual(["graph-confidentiality"]);
    expect(
      assessSsrDocument(reply(numeric), "", {
        ...expectation,
        forbidden: { angle: "a<b>c" },
      }).findings.map((finding) => finding.class),
    ).toEqual(["graph-confidentiality"]);
  });

  it("never copies document text, a forbidden value or a log secret into its diagnostics", () => {
    const leaky = documentWith(`<p>${PRIVATE}</p>`);
    const assessment = assessSsrDocument(reply(leaky), `ERROR ${PRIVATE}-in-log /a/b/c/d.js\n`, {
      ...expectation,
      content: { heading: "<h1>Product 42</h1>" },
    });
    const described = describeAssessment(assessment);

    expect(assessment.ok).toBe(false);
    expect(described).not.toContain("<p>");
    expect(described).toContain('server-only value "canary"');
    expect(
      assessment.findings
        .filter((finding) => finding.class === "graph-confidentiality")
        .every((finding) => !finding.detail.includes(PRIVATE)),
    ).toBe(true);
    expect(described).not.toContain("/a/b/c/d.js");
  });
});

describe("assessHydration", () => {
  it("accepts a hydrated, DOM-reusing observation without console errors", () => {
    expect(
      assessHydration({ hydratedWithinTimeout: true, errors: [], sameNodes: { button: true } }),
    ).toEqual([]);
  });

  it("classifies a missing hydration, a replaced SSR node and a console error separately", () => {
    const findings = assessHydration({
      hydratedWithinTimeout: false,
      errors: ["console.error: boom"],
      sameNodes: { button: false, heading: true },
    });

    expect(findings.map((finding) => finding.class)).toEqual([
      "client-hydration",
      "client-hydration",
      "client-hydration",
    ]);
    expect(findings[1]?.detail).toContain("button");
    expect(findings.map((finding) => finding.detail).join(" ")).not.toContain("boom");
  });
});
