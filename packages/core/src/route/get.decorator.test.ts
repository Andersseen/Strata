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

  it("rejects decorating a static method when the class is defined", () => {
    expect(() => {
      class Broken {
        @Get()
        static route() {}
      }
      return Broken;
    }).toThrow(
      new TypeError(
        '@Get() cannot decorate the static method "route". Route handlers must be instance methods.',
      ),
    );
  });

  it("rejects decorating a private method when the class is defined", () => {
    expect(() => {
      class Broken {
        @Get()
        #route() {}

        touch() {
          this.#route();
        }
      }
      return Broken;
    }).toThrow(/@Get\(\) cannot decorate the private method "#route"/);
  });

  it("accepts a protected instance method", () => {
    expect(() => {
      class Allowed {
        @Get()
        protected route() {}
      }
      return Allowed;
    }).not.toThrow();
  });
});
