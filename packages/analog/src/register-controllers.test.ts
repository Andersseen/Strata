import { Controller, Get } from "@strata/core";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type { NitroRouter, StrataAnalogRequest } from "./register-controllers.js";

/**
 * Builds the same H3 v1 shape Nitro 2 builds in `createNitroApp()` — an H3 app
 * with a `preemptive` router mounted on it — from H3's own public primitives.
 * The real Analog/Nitro server is covered by the `test:analog` fixture; these
 * tests only need the router, so nothing here is mocked.
 */
function createNitroLikeApp() {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(router.handler);

  const handle = toWebHandler(app);

  return {
    router,
    handle,
    request: (path: string) => handle(new Request(`http://localhost${path}`)),
  };
}

@Controller("/api/users")
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

@Controller("/api/orders")
class OrdersController {
  @Get()
  findAll() {
    return [{ id: "o1" }];
  }
}

describe("registerControllers", () => {
  it("registers a GET route on the router that returns the controller's result as JSON", async () => {
    const { router, request } = createNitroLikeApp();

    registerControllers(router, [UsersController]);

    const response = await request("/api/users");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual([{ id: "1", name: "Ada" }]);
  });

  it("returns the router it was given", () => {
    const { router } = createNitroLikeApp();

    expect(registerControllers(router, [UsersController])).toBe(router);
  });

  it("registers routes of a controller mounted at the root path", async () => {
    @Controller()
    class RootController {
      @Get("/health")
      health() {
        return { status: "ok" };
      }

      @Get()
      index() {
        return { page: "index" };
      }
    }

    const { router, request } = createNitroLikeApp();

    registerControllers(router, [RootController]);

    const [health, index] = await Promise.all([request("/health"), request("/")]);

    await expect(health.json()).resolves.toEqual({ status: "ok" });
    await expect(index.json()).resolves.toEqual({ page: "index" });
  });

  it("registers dynamic and nested route paths from route metadata", async () => {
    @Controller("/api/users")
    class NestedController {
      @Get("/:id")
      findOne() {
        return { route: "user" };
      }

      @Get("/:id/orders")
      findOrders() {
        return { route: "user-orders" };
      }
    }

    const { router, request } = createNitroLikeApp();

    registerControllers(router, [NestedController]);

    const [user, orders] = await Promise.all([
      request("/api/users/123"),
      request("/api/users/123/orders"),
    ]);

    await expect(user.json()).resolves.toEqual({ route: "user" });
    await expect(orders.json()).resolves.toEqual({ route: "user-orders" });
  });

  it("registers every @Get() route declared on a single controller", async () => {
    const { router, request } = createNitroLikeApp();

    registerControllers(router, [UsersController]);

    const [collection, byId] = await Promise.all([request("/api/users"), request("/api/users/1")]);

    expect(collection.status).toBe(200);
    expect(byId.status).toBe(200);
  });

  it("registers multiple independent controllers on the same router", async () => {
    const { router, request } = createNitroLikeApp();

    registerControllers(router, [UsersController, OrdersController]);

    const [users, orders] = await Promise.all([request("/api/users"), request("/api/orders")]);

    await expect(users.json()).resolves.toEqual([{ id: "1", name: "Ada" }]);
    await expect(orders.json()).resolves.toEqual([{ id: "o1" }]);
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

    const { router, request } = createNitroLikeApp();

    registerControllers(router, [MixedController]);

    const [sync, async] = await Promise.all([request("/mixed"), request("/mixed/async")]);

    await expect(sync.json()).resolves.toEqual({ kind: "sync" });
    await expect(async.json()).resolves.toEqual({ kind: "async" });
  });

  it("creates no controller instance at registration and a new one per request, bound as `this`", async () => {
    let constructed = 0;

    @Controller("/counter")
    class CounterController {
      private hits = 0;

      constructor() {
        constructed += 1;
      }

      @Get()
      hit() {
        this.hits += 1;

        return { hits: this.hits };
      }
    }

    const { router, request } = createNitroLikeApp();

    registerControllers(router, [CounterController]);

    expect(constructed).toBe(0);

    const first = await request("/counter");
    const second = await request("/counter");

    await expect(first.json()).resolves.toEqual({ hits: 1 });
    await expect(second.json()).resolves.toEqual({ hits: 1 });
    expect(constructed).toBe(2);
  });

  it("passes Strata's request boundary to controller methods without exposing the H3 event", async () => {
    let received: StrataAnalogRequest | undefined;

    @Controller("/request")
    class RequestController {
      @Get()
      inspect(request: StrataAnalogRequest) {
        received = request;

        return { ok: true };
      }
    }

    const { router, request } = createNitroLikeApp();

    registerControllers(router, [RequestController]);

    await request("/request?search=ada");

    expect(received).toMatchObject({
      method: "GET",
      path: "/request",
      params: {},
      query: { search: "ada" },
    });
    expect(received).not.toHaveProperty("node");
    expect(received).not.toHaveProperty("web");
    expect(received?.headers).toBeInstanceOf(Headers);
    expect(received?.url).toBeInstanceOf(URL);
  });

  it("provides route params and repeated query values through Strata's request boundary", async () => {
    @Controller("/api/users")
    class RequestInputController {
      @Get("/:id")
      findOne(request: StrataAnalogRequest) {
        return {
          id: request.params["id"],
          include: request.query["include"],
          tag: request.query["tag"],
        };
      }
    }

    const { router, request } = createNitroLikeApp();

    registerControllers(router, [RequestInputController]);

    const response = await request("/api/users/42?include=profile&tag=a&tag=b");

    await expect(response.json()).resolves.toEqual({
      id: "42",
      include: "profile",
      tag: ["a", "b"],
    });
  });

  it("provides a shallow context snapshot through Strata's request boundary", async () => {
    @Controller("/context")
    class ContextController {
      @Get()
      inspect(request: StrataAnalogRequest) {
        return { traceId: request.context["traceId"] };
      }
    }

    const app = createApp();
    const router = createRouter({ preemptive: true });

    app.use(
      defineEventHandler((event) => {
        event.context["traceId"] = "trace-1";
      }),
    );
    app.use(router.handler);

    const handle = toWebHandler(app);

    registerControllers(router, [ContextController]);

    const response = await handle(new Request("http://localhost/context"));

    await expect(response.json()).resolves.toEqual({ traceId: "trace-1" });
  });

  it("provides lazy text, JSON and content-type-aware body readers", async () => {
    const registeredHandlers: Array<
      (event: {
        method?: string;
        path?: string;
        headers?: Headers;
        context?: Record<string, unknown>;
        web?: { request?: Request };
      }) => unknown
    > = [];
    const router = {
      add(_path, handler) {
        registeredHandlers.push(handler);
      },
    } satisfies NitroRouter;

    @Controller("/body")
    class BodyController {
      @Get()
      async read(request: StrataAnalogRequest) {
        return {
          json: await request.readJson(),
          body: await request.readBody(),
          text: await request.readText(),
        };
      }
    }

    registerControllers(router, [BodyController]);

    const handler = registeredHandlers[0];

    if (!handler) {
      throw new Error("Expected registerControllers() to add a route handler.");
    }

    await expect(
      handler({
        method: "POST",
        path: "/body",
        headers: new Headers({ "content-type": "application/json" }),
        context: {},
        web: {
          request: new Request("http://localhost/body", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Ada" }),
          }),
        },
      }),
    ).resolves.toEqual({
      json: { name: "Ada" },
      body: { name: "Ada" },
      text: JSON.stringify({ name: "Ada" }),
    });
  });

  it("lets native Nitro routes keep working alongside Strata controllers", async () => {
    const { router, request } = createNitroLikeApp();

    // A file-system route (`src/server/routes/api/native.ts`) is registered by
    // Nitro on this same router, before server plugins run.
    router.get(
      "/api/native",
      defineEventHandler(() => ({ source: "analog" })),
    );

    registerControllers(router, [UsersController]);

    const [native, users] = await Promise.all([request("/api/native"), request("/api/users")]);

    await expect(native.json()).resolves.toEqual({ source: "analog" });
    await expect(users.json()).resolves.toEqual([{ id: "1", name: "Ada" }]);
  });

  it("does not answer other methods or unknown paths on Strata routes", async () => {
    const { router, handle } = createNitroLikeApp();

    registerControllers(router, [UsersController]);

    const post = await handle(new Request("http://localhost/api/users", { method: "POST" }));
    const unknown = await handle(new Request("http://localhost/api/nothing"));

    expect(post.status).toBe(405);
    expect(unknown.status).toBe(404);
  });

  it("throws a configuration error for a class without @Controller()", () => {
    class PlainClass {
      @Get()
      findAll() {
        return [];
      }
    }

    const { router } = createNitroLikeApp();

    expect(() => registerControllers(router, [PlainClass])).toThrow(StrataAnalogConfigurationError);
    expect(() => registerControllers(router, [PlainClass])).toThrow(/@Controller\(\)/);
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

    const { router } = createNitroLikeApp();

    expect(() => registerControllers(router, [BrokenController])).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(() => registerControllers(router, [BrokenController])).toThrow(
      /BrokenController\.findAll/,
    );
  });
});
