import { Controller, Get } from "@strata/core";
import { H3 } from "h3";
import { describe, expect, it } from "vitest";

import { StrataH3ConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";

@Controller("/users")
class UsersController {
  @Get()
  findAll() {
    return [{ id: "1", name: "Ada" }];
  }

  @Get("/:id")
  findOne() {
    return { id: "1", name: "Ada" };
  }
}

@Controller("/orders")
class OrdersController {
  @Get()
  findAll() {
    return [{ id: "o1" }];
  }
}

describe("registerControllers", () => {
  it("registers a basic GET route that returns the controller's result as JSON", async () => {
    const app = new H3();

    registerControllers(app, [UsersController]);

    const response = await app.request("/users");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "1", name: "Ada" }]);
  });

  it("registers dynamic H3 routes from route metadata", async () => {
    const app = new H3();

    registerControllers(app, [UsersController]);

    const response = await app.request("/users/123");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "1", name: "Ada" });
  });

  it("registers every @Get() route declared on a single controller", async () => {
    const app = new H3();

    registerControllers(app, [UsersController]);

    const [collection, byId] = await Promise.all([app.request("/users"), app.request("/users/1")]);

    expect(collection.status).toBe(200);
    expect(byId.status).toBe(200);
  });

  it("registers multiple independent controllers on the same app", async () => {
    const app = new H3();

    registerControllers(app, [UsersController, OrdersController]);

    const [users, orders] = await Promise.all([app.request("/users"), app.request("/orders")]);

    expect(users.status).toBe(200);
    await expect(orders.json()).resolves.toEqual([{ id: "o1" }]);
  });

  it("lets native H3 routes keep working alongside Strata controllers", async () => {
    const app = new H3();

    app.get("/health", () => ({ status: "ok" }));

    registerControllers(app, [UsersController]);

    const [health, users] = await Promise.all([app.request("/health"), app.request("/users")]);

    await expect(health.json()).resolves.toEqual({ status: "ok" });
    await expect(users.json()).resolves.toEqual([{ id: "1", name: "Ada" }]);
  });

  it("throws a configuration error for a class without @Controller()", () => {
    class PlainClass {
      @Get()
      findAll() {
        return [];
      }
    }

    const app = new H3();

    expect(() => registerControllers(app, [PlainClass])).toThrow(StrataH3ConfigurationError);
  });

  it("throws a configuration error when a route handler is not callable", () => {
    @Controller("/broken")
    class BrokenController {
      @Get()
      findAll() {
        return [];
      }
    }

    // Simulate metadata pointing at a property that isn't a method.
    Object.defineProperty(BrokenController.prototype, "findAll", {
      value: "not a function",
      configurable: true,
    });

    const app = new H3();

    expect(() => registerControllers(app, [BrokenController])).toThrow(StrataH3ConfigurationError);
  });

  it("supports both sync and async handler return values", async () => {
    @Controller("/mixed")
    class MixedController {
      @Get()
      sync() {
        return { kind: "sync" };
      }

      @Get("/async")
      async asyncHandler() {
        await Promise.resolve();
        return { kind: "async" };
      }
    }

    const app = new H3();

    registerControllers(app, [MixedController]);

    const [sync, async] = await Promise.all([app.request("/mixed"), app.request("/mixed/async")]);

    await expect(sync.json()).resolves.toEqual({ kind: "sync" });
    await expect(async.json()).resolves.toEqual({ kind: "async" });
  });
});
