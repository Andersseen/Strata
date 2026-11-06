// @vitest-environment node
import { describe, expect, it } from "vitest";

import { expectedPages, PUBLIC_PAGES, renderPage, stalePages } from "../../scripts/public-docs";

const page = { ...PUBLIC_PAGES[0], omit: undefined };

describe("public documentation", () => {
  it("is in sync with the repository Markdown it is generated from", () => {
    expect(stalePages()).toEqual([]);
  });

  it("publishes no internal document", () => {
    const sources = PUBLIC_PAGES.map(({ source }) => source).join(" ");

    expect(sources).not.toMatch(/research|STATE|RISKS|ROADMAP|RELEASE-1\.0|specs\/|adr\//);
  });

  it("never mentions the internal documentation tooling", () => {
    for (const [file, text] of expectedPages()) expect(text, file).not.toMatch(/entwine/i);
  });

  it("omits a section by heading, and refuses one that disappeared", () => {
    const text = renderPage(
      { ...page, omit: ["Internal"] },
      "# T\n\n## Public\n\nkept\n\n## Internal\n\ngone\n\n## Next\n\nkept too\n",
    );

    expect(text).toContain("kept too");
    expect(text).not.toContain("gone");
    expect(() => renderPage({ ...page, omit: ["Missing"] }, "# T\n")).toThrow(/no section/);
  });

  it("leaves no relative link behind that the site could not resolve", () => {
    for (const [file, text] of expectedPages()) {
      const prose = text.replace(/```[\s\S]*?```/g, "");
      const relative = [...prose.matchAll(/\]\((?!https?:|mailto:|#|\/docs)([^)\s]+)\)/g)];

      expect(
        relative.map(([, target]) => target),
        file,
      ).toEqual([]);
    }
  });

  it("retargets public pages to the site and private ones to GitHub", () => {
    const text = renderPage(
      page,
      "# T\n\n[a](COMPATIBILITY.md#x) [b](research/report.md) [c](https://x.dev) [d](#local)\n",
    );

    expect(text).toContain("[a](/docs/compatibility#x)");
    expect(text).toContain(
      "[b](https://github.com/Andersseen/Strata/blob/main/docs/research/report.md)",
    );
    expect(text).toContain("[c](https://x.dev)");
    expect(text).toContain("[d](#local)");
  });

  it("does not rewrite links inside code blocks", () => {
    expect(renderPage(page, "# T\n\n```md\n[a](COMPATIBILITY.md)\n```\n")).toContain(
      "[a](COMPATIBILITY.md)",
    );
  });

  it("fails loudly when a selected section disappears", () => {
    expect(() => renderPage({ ...page, sections: ["Missing"] }, "# T\n")).toThrow(/no section/);
  });
});
