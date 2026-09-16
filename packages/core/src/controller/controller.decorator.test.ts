import { describe, expect, it } from "vitest";

import { Get } from "../route/get.decorator.js";

import { Controller } from "./controller.decorator.js";
import { getControllerDefinition } from "./get-controller-definition.js";

describe("@Controller / @Get metadata", () => {
  it("describes a controller with multiple GET routes", () => {
    @Controller("/users")
    class UsersController {
      @Get()
      findAll() {}

      @Get("/:id")
      findOne() {}
    }

    const definition = getControllerDefinition(UsersController);

    expect(definition?.path).toBe("/users");
    expect(definition?.routes).toHaveLength(2);
    expect(definition?.routes[0]).toEqual({ method: "GET", path: "/", handler: "findAll" });
    expect(definition?.routes[1]).toEqual({ method: "GET", path: "/:id", handler: "findOne" });
  });

  it("defaults an unspecified controller path to the root path", () => {
    @Controller()
    class RootController {
      @Get()
      index() {}
    }

    expect(getControllerDefinition(RootController)?.path).toBe("/");
  });

  it("normalizes a controller path without a leading slash", () => {
    @Controller("orders")
    class OrdersController {}

    expect(getControllerDefinition(OrdersController)?.path).toBe("/orders");
  });

  it("normalizes a trailing slash on the controller path", () => {
    @Controller("/orders/")
    class OrdersController {}

    expect(getControllerDefinition(OrdersController)?.path).toBe("/orders");
  });

  it("returns an empty route list for a controller with no routes", () => {
    @Controller("/health")
    class HealthController {}

    expect(getControllerDefinition(HealthController)?.routes).toEqual([]);
  });

  it("preserves declaration order across many GET routes", () => {
    @Controller("/items")
    class ItemsController {
      @Get()
      a() {}
      @Get("/b")
      b() {}
      @Get("/c")
      c() {}
      @Get("/d")
      d() {}
    }

    expect(getControllerDefinition(ItemsController)?.routes.map((route) => route.handler)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("normalizes a bare path parameter on a route", () => {
    @Controller("/users")
    class UsersController {
      @Get(":id")
      findOne() {}
    }

    expect(getControllerDefinition(UsersController)?.routes[0]?.path).toBe("/:id");
  });

  it("does not share metadata between independent controllers", () => {
    @Controller("/a")
    class AController {
      @Get()
      one() {}
    }

    @Controller("/b")
    class BController {
      @Get()
      two() {}
      @Get("/three")
      three() {}
    }

    expect(getControllerDefinition(AController)?.routes.map((route) => route.handler)).toEqual([
      "one",
    ]);
    expect(getControllerDefinition(BController)?.routes.map((route) => route.handler)).toEqual([
      "two",
      "three",
    ]);
    expect(getControllerDefinition(AController)?.path).toBe("/a");
    expect(getControllerDefinition(BController)?.path).toBe("/b");
  });

  it("returns undefined for a class that was never decorated with @Controller", () => {
    class PlainClass {
      @Get()
      handler() {}
    }

    expect(getControllerDefinition(PlainClass)).toBeUndefined();
  });

  it("returns a frozen definition that cannot be mutated by consumers", () => {
    @Controller("/frozen")
    class FrozenController {
      @Get()
      handler() {}
    }

    const definition = getControllerDefinition(FrozenController);

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition?.routes)).toBe(true);
  });
});
