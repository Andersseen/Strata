import { describe, expect, it } from "vitest";

import { Controller } from "../controller/controller.decorator.js";
import { getControllerDefinition } from "../controller/get-controller-definition.js";

import { Delete, Get, Patch, Post, Put } from "./http-method.decorators.js";
import type { HttpMethod } from "./route.types.js";

const DECORATORS = [
  { name: "Get", method: "GET", decorator: Get },
  { name: "Post", method: "POST", decorator: Post },
  { name: "Put", method: "PUT", decorator: Put },
  { name: "Patch", method: "PATCH", decorator: Patch },
  { name: "Delete", method: "DELETE", decorator: Delete },
] as const satisfies ReadonlyArray<{ name: string; method: HttpMethod; decorator: typeof Get }>;

describe.each(DECORATORS)("@$name", ({ name, method, decorator: Route }) => {
  it(`records ${method} with a normalized path and the handler name`, () => {
    @Controller("/items")
    class Items {
      @Route()
      root() {}

      @Route(":id")
      byId() {}

      @Route("/nested/")
      nested() {}
    }

    expect(getControllerDefinition(Items)).toEqual({
      path: "/items",
      routes: [
        { method, path: "/", handler: "root" },
        { method, path: "/:id", handler: "byId" },
        { method, path: "/nested", handler: "nested" },
      ],
    });
  });

  it("returns frozen route records", () => {
    @Controller()
    class Frozen {
      @Route()
      handler() {}
    }

    const [route] = getControllerDefinition(Frozen)?.routes ?? [];

    expect(route).toBeDefined();
    expect(Object.isFrozen(route)).toBe(true);
  });

  it("keeps the route on the declaring class only", () => {
    @Controller("/base")
    class Base {
      @Route()
      handler() {}
    }

    @Controller("/child")
    class Child extends Base {}

    expect(getControllerDefinition(Base)?.routes).toEqual([
      { method, path: "/", handler: "handler" },
    ]);
    expect(getControllerDefinition(Child)).toEqual({ path: "/child", routes: [] });
  });

  it("accepts a protected instance method", () => {
    expect(() => {
      class Allowed {
        @Route()
        protected route() {}
      }
      return Allowed;
    }).not.toThrow();
  });

  it("rejects a static method, naming the decorator", () => {
    expect(() => {
      class Broken {
        @Route()
        static route() {}
      }
      return Broken;
    }).toThrow(
      new TypeError(
        `@${name}() cannot decorate the static method "route". Route handlers must be instance methods.`,
      ),
    );
  });

  it("rejects a private method, naming the decorator", () => {
    expect(() => {
      class Broken {
        @Route()
        #route() {}

        touch() {
          this.#route();
        }
      }
      return Broken;
    }).toThrow(
      new TypeError(
        `@${name}() cannot decorate the private method "#route". Route handlers must be public or protected instance methods.`,
      ),
    );
  });

  it("rejects a symbol-named method, naming the decorator", () => {
    const symbolKey = Symbol("computed");

    expect(() => {
      class Broken {
        @Route()
        [symbolKey]() {}
      }
      return Broken;
    }).toThrow(new TypeError(`@${name}() can only decorate methods with a string name.`));
  });
});

describe("mixed HTTP method decorators", () => {
  it("preserves declaration order across methods", () => {
    @Controller("/mixed")
    class MixedController {
      @Get()
      read() {}

      @Post()
      create() {}

      @Put("/:id")
      replace() {}

      @Patch("/:id")
      patch() {}

      @Delete("/:id")
      remove() {}
    }

    expect(getControllerDefinition(MixedController)).toEqual({
      path: "/mixed",
      routes: [
        { method: "GET", path: "/", handler: "read" },
        { method: "POST", path: "/", handler: "create" },
        { method: "PUT", path: "/:id", handler: "replace" },
        { method: "PATCH", path: "/:id", handler: "patch" },
        { method: "DELETE", path: "/:id", handler: "remove" },
      ],
    });
  });

  it("records one route per decorator when a method carries several", () => {
    @Controller("/multi")
    class Multi {
      @Get()
      @Post()
      handler() {}
    }

    // Standard method decorators run bottom-up.
    expect(getControllerDefinition(Multi)?.routes.map((route) => route.method)).toEqual([
      "POST",
      "GET",
    ]);
  });
});
