import { describe, expect, it } from "vitest";

import { Get } from "../route/http-method.decorators.js";

import { Controller } from "./controller.decorator.js";
import { getControllerDefinition } from "./get-controller-definition.js";

type AnyClass = abstract new (...args: never[]) => unknown;

function routesOf(target: AnyClass): string[] | undefined {
  return getControllerDefinition(target)?.routes.map((route) => `${route.path}:${route.handler}`);
}

describe("controller metadata ownership across class inheritance", () => {
  it("does not make an undecorated subclass of a controller a controller", () => {
    @Controller("/base")
    class Base {
      @Get("/base-route")
      baseRoute() {}
    }

    class Child extends Base {}

    expect(getControllerDefinition(Base)?.path).toBe("/base");
    expect(getControllerDefinition(Child)).toBeUndefined();
  });

  it("gives a decorated subclass its own definition, without the base class's routes", () => {
    @Controller("/base")
    class Base {
      @Get("/base-route")
      baseRoute() {}
    }

    @Controller("/child")
    class Child extends Base {}

    expect(getControllerDefinition(Base)).toEqual({
      path: "/base",
      routes: [{ method: "GET", path: "/base-route", handler: "baseRoute" }],
    });
    expect(getControllerDefinition(Child)).toEqual({ path: "/child", routes: [] });
  });

  it("keeps base and subclass routes separate and never writes subclass routes into the base", () => {
    @Controller("/base")
    class Base {
      @Get("/one")
      one() {}
    }

    const baseDefinition = getControllerDefinition(Base);

    @Controller("/child")
    class Child extends Base {
      @Get("/two")
      two() {}
    }

    expect(routesOf(Base)).toEqual(["/one:one"]);
    expect(routesOf(Child)).toEqual(["/two:two"]);
    expect(getControllerDefinition(Base)).toBe(baseDefinition);
  });

  it("isolates sibling subclasses from each other and from their base", () => {
    @Controller("/base")
    class Base {
      @Get("/base")
      base() {}
    }

    @Controller("/a")
    class ChildA extends Base {
      @Get("/a1")
      a1() {}
      @Get("/a2")
      a2() {}
    }

    const childADefinition = getControllerDefinition(ChildA);

    @Controller("/b")
    class ChildB extends Base {
      @Get("/b1")
      b1() {}
    }

    expect(routesOf(Base)).toEqual(["/base:base"]);
    expect(routesOf(ChildA)).toEqual(["/a1:a1", "/a2:a2"]);
    expect(routesOf(ChildB)).toEqual(["/b1:b1"]);
    expect(getControllerDefinition(ChildA)).toBe(childADefinition);
  });

  it("does not promote an undecorated subclass with its own @Get() routes to a controller", () => {
    @Controller("/base")
    class Base {
      @Get()
      base() {}
    }

    class Child extends Base {
      @Get("/child")
      child() {}
    }

    expect(getControllerDefinition(Child)).toBeUndefined();
    expect(routesOf(Base)).toEqual(["/:base"]);
  });

  it("builds a decorated grandchild from its own routes only", () => {
    @Controller("/base")
    class Base {
      @Get("/base")
      base() {}
    }

    class Middle extends Base {
      @Get("/middle")
      middle() {}
    }

    @Controller("/leaf")
    class Leaf extends Middle {
      @Get("/leaf")
      leaf() {}
    }

    expect(getControllerDefinition(Middle)).toBeUndefined();
    expect(routesOf(Leaf)).toEqual(["/leaf:leaf"]);
    expect(routesOf(Base)).toEqual(["/base:base"]);
  });

  it("does not inherit a route when a subclass overrides the method without @Get()", () => {
    @Controller("/base")
    class Base {
      @Get("/item")
      item() {}
    }

    @Controller("/child")
    class Child extends Base {
      override item() {}
    }

    expect(routesOf(Base)).toEqual(["/item:item"]);
    expect(routesOf(Child)).toEqual([]);
  });

  it("records an own route when a subclass overrides the method with @Get()", () => {
    @Controller("/base")
    class Base {
      @Get("/item")
      item() {}
    }

    @Controller("/child")
    class Child extends Base {
      @Get("/item")
      override item() {}
    }

    expect(routesOf(Base)).toEqual(["/item:item"]);
    expect(routesOf(Child)).toEqual(["/item:item"]);
    expect(getControllerDefinition(Child)?.routes).not.toBe(getControllerDefinition(Base)?.routes);
  });
});

describe("controller metadata storage", () => {
  it("preserves metadata written by other decorators", () => {
    const foreignKey = Symbol("other-library");

    function Tag(value: string) {
      return (_target: unknown, context: DecoratorContext) => {
        context.metadata["tag"] = value;
        context.metadata[foreignKey] = value;
      };
    }

    @Tag("class")
    @Controller("/tagged")
    class Tagged {
      @Get()
      handler() {}
    }

    const metadata = Tagged[Symbol.metadata];

    expect(metadata?.["tag"]).toBe("class");
    expect(metadata?.[foreignKey]).toBe("class");
    expect(routesOf(Tagged)).toEqual(["/:handler"]);
  });

  it("returns frozen route records", () => {
    @Controller("/frozen")
    class Frozen {
      @Get()
      handler() {}
    }

    const definition = getControllerDefinition(Frozen);

    expect(definition?.routes.every((route) => Object.isFrozen(route))).toBe(true);
  });
});
