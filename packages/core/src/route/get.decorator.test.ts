import { describe, expect, it } from "vitest";

import { Get } from "./get.decorator.js";

describe("@Get", () => {
  it("rejects decorating a symbol-named method", () => {
    const symbolKey = Symbol("computed");

    expect(() => {
      class Broken {
        @Get()
        [symbolKey]() {}
      }
      return Broken;
    }).toThrow(TypeError);
  });
});
