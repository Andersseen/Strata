import { afterEach, describe, expect, it, vi } from "vitest";

const globalSymbol = Symbol as unknown as { metadata?: symbol };
const original = globalSymbol.metadata;

afterEach(() => {
  if (original === undefined) {
    delete globalSymbol.metadata;
  } else {
    globalSymbol.metadata = original;
  }
});

describe("Symbol.metadata polyfill", () => {
  it("keeps an existing Symbol.metadata instead of replacing it", async () => {
    const existing = Symbol("existing Symbol.metadata");
    globalSymbol.metadata = existing;

    vi.resetModules();
    await import("./decorator-metadata-polyfill.js");

    expect(globalSymbol.metadata).toBe(existing);
  });

  it("defines Symbol.metadata when the runtime lacks it", async () => {
    delete globalSymbol.metadata;

    vi.resetModules();
    await import("./decorator-metadata-polyfill.js");

    expect(typeof globalSymbol.metadata).toBe("symbol");
  });
});
