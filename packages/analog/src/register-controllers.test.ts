import { Controller, Get, Post } from "@strata-sc/core";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

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
  it("validates params, query and JSON with Standard Schema implementations and preserves outputs", async () => {
    const { router, handle, request } = createNitroLikeApp();
    let cleaned = 0;
    const paramsSchema = z.object({ id: z.string().transform(Number) });
    const querySchema = v.object({ page: v.pipe(v.string(), v.transform(Number)) });
    expectTypeOf<z.output<typeof paramsSchema>>().toEqualTypeOf<{ id: number }>();

    @Controller("/validated")
    class ValidatedController {
      @Get("/:id")
      async read(request: StrataAnalogRequest) {
        const params: Promise<{ id: number }> = request.validateParams(paramsSchema);
        const query: Promise<{ page: number }> = request.validateQuery(querySchema);
        return {
          params: await params,
          query: await query,
        };
      }

      @Post()
      async create(request: StrataAnalogRequest) {
        const bodyPromise: Promise<{ count: number }> = request.readValidatedJson(
          z.object({ count: z.string().transform(Number) }),
        );
        const body = await bodyPromise;
        return body;
      }
    }

    registerControllers(router, [ValidatedController], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          cleaned += 1;
        });
        return new controller();
      },
    });

    const result = await request("/validated/42?page=3");
    await expect(result.json()).resolves.toEqual({ params: { id: 42 }, query: { page: 3 } });
    const bodyResponse = await handle(
      new Request("http://localhost/validated", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: "7" }),
      }),
    );
    await expect(bodyResponse.json()).resolves.toEqual({ count: 7 });
    expect(cleaned).toBe(2);
  });

  it("returns safe validation responses only after successful cleanup", async () => {
    const { router, handle } = createNitroLikeApp();
    const secret = "PRIVATE_SCHEMA_CANARY";
    let cleanups = 0;

    @Controller("/invalid")
    class InvalidController {
      @Get()
      async get(request: StrataAnalogRequest) {
        await request.validateQuery(z.object({ required: z.string().refine(() => false, secret) }));
        return { mustNotRun: true };
      }
    }

    registerControllers(router, [InvalidController], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          cleanups += 1;
        });
        return new controller();
      },
    });
    const response = await handle(new Request("http://localhost/invalid?required=x"));
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toBe('{"error":"invalid_request","source":"query"}');
    expect(text).not.toContain(secret);
    expect(cleanups).toBe(1);
  });

  it("does not classify validator throws or cleanup failures as client errors", async () => {
    const { router, handle } = createNitroLikeApp();
    const throwing = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw new Error("private");
        },
      },
    } as const;
    @Controller("/throws")
    class ThrowsController {
      @Get()
      run(request: StrataAnalogRequest) {
        return request.validateQuery(throwing);
      }
    }
    registerControllers(router, [ThrowsController]);
    const unexpected = await handle(new Request("http://localhost/throws"));
    expect(unexpected.status).toBe(500);
    expect(unexpected.headers.get("cache-control")).not.toBe("no-store");

    @Controller("/cleanup")
    class CleanupController {
      @Get()
      async run(request: StrataAnalogRequest) {
        return request.validateQuery(z.object({ ok: z.string() }));
      }
    }
    registerControllers(router, [CleanupController], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          throw new Error("cleanup");
        });
        return new controller();
      },
    });
    const cleanupFailure = await handle(new Request("http://localhost/cleanup"));
    expect(cleanupFailure.status).toBe(500);
    expect(cleanupFailure.headers.get("cache-control")).not.toBe("no-store");
  });

  it("bounds validated JSON and applies the media type and JSON failure contract", async () => {
    const { router, handle } = createNitroLikeApp();
    @Controller("/json")
    class JsonController {
      @Post()
      async read(request: StrataAnalogRequest) {
        return request.readValidatedJson(z.unknown());
      }
    }
    registerControllers(router, [JsonController]);
    const send = (body: string, contentType = "application/json") =>
      handle(
        new Request("http://localhost/json", {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        }),
      );
    for (const [body, contentType, status, code] of [
      ["{", "application/json; charset=utf-8", 400, "invalid_request"],
      ["{}", "text/plain", 415, "unsupported_media_type"],
      ["{}", "application/json; charset=utf-16", 415, "unsupported_media_type"],
      [
        JSON.stringify({ data: "x".repeat(1024 * 1024) }),
        "application/json",
        413,
        "payload_too_large",
      ],
    ] as const) {
      const response = await send(body, contentType);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: code, source: "body" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("keeps validation data and cleanup isolated across 24 overlapping requests", async () => {
    const { router, handle } = createNitroLikeApp();
    let cleanupCount = 0;
    const paramsSchema = z.object({ id: z.string().regex(/^r\d+$/) });
    const querySchema = z.object({ trace: z.string() });
    const bodySchema = z.object({ id: z.string(), privateValue: z.string() });

    @Controller("/isolation")
    class IsolationController {
      @Post("/:id")
      async run(request: StrataAnalogRequest) {
        const params = await request.validateParams(paramsSchema);
        const query = await request.validateQuery(querySchema);
        const body = await request.readValidatedJson(bodySchema);
        await new Promise((resolve) => setTimeout(resolve, Number(params.id.slice(1)) % 4));
        return {
          id: params.id,
          trace: query.trace,
          bodyId: body.id,
          privateValue: body.privateValue,
        };
      }
    }
    registerControllers(router, [IsolationController], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          cleanupCount += 1;
        });
        return new controller();
      },
    });

    const responses = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const id = `r${index}`;
        const valid = index % 2 === 0;
        const response = await handle(
          new Request(`http://localhost/isolation/${valid ? id : "bad"}?trace=trace-${index}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-correlation-id": `corr-${index}` },
            body: JSON.stringify({ id, privateValue: `canary-${index}` }),
          }),
        );
        const text = await response.text();
        if (!valid) {
          expect(response.status).toBe(400);
          expect(text).not.toContain(`canary-${index}`);
          return null;
        }
        expect(response.status).toBe(200);
        expect(JSON.parse(text)).toEqual({
          id,
          trace: `trace-${index}`,
          bodyId: id,
          privateValue: `canary-${index}`,
        });
        return text;
      }),
    );

    expect(responses.filter(Boolean)).toHaveLength(12);
    expect(cleanupCount).toBe(24);
  });

  it("preserves dangerous record keys, decodes split UTF-8 and ignores false Content-Length", async () => {
    const handlers: Array<(event: object) => unknown> = [];
    const router = {
      add(_path: string, handler: (event: object) => unknown) {
        handlers.push(handler);
      },
    } satisfies NitroRouter;
    @Controller("/boundary")
    class BoundaryController {
      @Get()
      inspect(request: StrataAnalogRequest) {
        return {
          query: request.query,
          proto: Object.getPrototypeOf(request.query) === Object.prototype,
          ownsProto: Object.hasOwn(request.query, "__proto__"),
        };
      }
    }
    registerControllers(router, [BoundaryController]);
    const handler = handlers[0];
    if (!handler) throw new Error("Expected route handler.");
    const { router: h3Router, handle } = createNitroLikeApp();
    @Controller("/utf8")
    class Utf8Controller {
      @Post()
      async read(request: StrataAnalogRequest) {
        return request.readValidatedJson(z.object({ text: z.string() }));
      }
    }
    registerControllers(h3Router, [Utf8Controller]);
    const text = '{"text":"😀"}';
    const bytes = new TextEncoder().encode(text);
    const emojiStart = bytes.indexOf(0xf0);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, emojiStart + 2));
        controller.enqueue(bytes.slice(emojiStart + 2));
        controller.close();
      },
    });
    const utf8Response = await handle(
      new Request("http://localhost/utf8", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      }),
    );
    await expect(utf8Response.json()).resolves.toEqual({ text: "😀" });

    const queryResponse = await handler({
      method: "GET",
      path: "/boundary?__proto__=own&constructor=ctor&prototype=proto",
      web: {
        request: new Request(
          "http://localhost/boundary?__proto__=own&constructor=ctor&prototype=proto",
        ),
      },
      context: {},
    });
    expect(queryResponse).toMatchObject({ proto: true, ownsProto: true });
    const query = (queryResponse as { query: Record<string, unknown> }).query;
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    expect(Object.hasOwn(query, "__proto__")).toBe(true);
    expect(query["__proto__"]).toBe("own");
    expect(query.constructor).toBe("ctor");
    expect(query["prototype"]).toBe("proto");

    const oversizedHandlerList: Array<(event: object) => unknown> = [];
    const oversizedRouter = {
      add(_path: string, routeHandler: (event: object) => unknown) {
        oversizedHandlerList.push(routeHandler);
      },
    } satisfies NitroRouter;
    @Controller("/oversized")
    class OversizedController {
      @Post()
      async read(request: StrataAnalogRequest) {
        return request.readValidatedJson(z.unknown());
      }
    }
    registerControllers(oversizedRouter, [OversizedController]);
    const oversizedHandler = oversizedHandlerList[0];
    if (!oversizedHandler) throw new Error("Expected oversized route handler.");
    const oversizedResponse = await oversizedHandler({
      method: "POST",
      path: "/oversized",
      headers: new Headers({ "content-type": "application/json", "content-length": "1" }),
      node: {
        req: {
          headers: { "content-type": "application/json", "content-length": "1" },
          rawBody: new Uint8Array(1024 * 1024 + 1),
        },
      },
    });
    expect(oversizedResponse).toBeInstanceOf(Response);
    expect((oversizedResponse as Response).status).toBe(413);
  });

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

  it("preserves a successful Response status, headers and body through pinned H3 v1", async () => {
    @Controller("/response")
    class ResponseController {
      @Get()
      handle() {
        return new Response("created", {
          status: 201,
          headers: { "content-type": "text/plain", "x-fixture": "preserved" },
        });
      }
    }
    const { router, handle } = createNitroLikeApp();
    registerControllers(router, [ResponseController]);
    const response = await handle(new Request("http://localhost/response"));
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-fixture")).toBe("preserved");
    await expect(response.text()).resolves.toBe("created");
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
