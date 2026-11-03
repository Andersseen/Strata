import { describe, expect, it } from "vitest";

import { highlight } from "./highlight";

describe("highlight", () => {
  it("keeps the exact source text", () => {
    const source = `@Controller("/api")\nexport class A {\n  // note\n  list() { return [1]; }\n}`;

    expect(
      highlight(source)
        .map((token) => token.text)
        .join(""),
    ).toBe(source);
  });

  it("classifies TypeScript tokens", () => {
    const tokens = highlight(`@ServerComponent()\nconst x = inject(Repo); // hi\n"s"`);
    const kindOf = (text: string) => tokens.find((token) => token.text.includes(text))?.kind;

    expect(kindOf("@ServerComponent")).toBe("decorator");
    expect(kindOf("const")).toBe("keyword");
    expect(kindOf("inject")).toBe("function");
    expect(kindOf("Repo")).toBe("type");
    expect(kindOf("// hi")).toBe("comment");
    expect(kindOf('"s"')).toBe("string");
  });

  it("does not highlight keywords inside strings or comments", () => {
    const tokens = highlight(`"import from" // export class`);

    expect(tokens.filter((token) => token.kind === "keyword")).toEqual([]);
  });

  it("highlights shell commands, flags, packages and comments", () => {
    const tokens = highlight("pnpm add -D @strata-sc/core # controllers", "shell");
    const kindOf = (text: string) => tokens.find((token) => token.text === text)?.kind;

    expect(kindOf("pnpm")).toBe("function");
    expect(kindOf("-D")).toBe("keyword");
    expect(kindOf("@strata-sc/core")).toBe("type");
    expect(kindOf("# controllers")).toBe("comment");
  });
});
