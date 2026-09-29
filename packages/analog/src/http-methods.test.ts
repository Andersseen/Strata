import { Controller, Delete, Get, Patch, Post, Put } from "@strata-sc/core";
import { createApp, createRouter, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";

import { registerControllers } from "./register-controllers.js";
import type { RegisterControllersOptions, StrataAnalogRequest } from "./register-controllers.js";

/** The H3 v1 app + preemptive router Nitro 2 builds, from H3's public primitives. */
function createNitroLikeApp() {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(router.handler);

  const handle = toWebHandler(app);

  return {
    router,
    send: (method: string, path: string, body?: unknown) =>
      handle(
        new Request(`http://localhost${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        }),
      ),
  };
}

@Controller("/api/items")
class MethodTableController {
  @Get()
  get(request: StrataAnalogRequest) {
    return { handler: "get", method: request.method };
  }

  @Post()
  post(request: StrataAnalogRequest) {
    return { handler: "post", method: request.method };
  }

  @Put()
  put(request: StrataAnalogRequest) {
    return { handler: "put", method: request.method };
  }

  @Patch()
  patch(request: StrataAnalogRequest) {
    return { handler: "patch", method: request.method };
  }

  @Delete()
  delete(request: StrataAnalogRequest) {
    return { handler: "delete", method: request.method };
  }
}

@Controller("/api/items")
class ItemsController {
  @Post()
  async create(request: StrataAnalogRequest) {
    const body = await request.readJson<{ name: string }>();

    return { method: request.method, name: body.name };
  }

  @Put("/:id")
  async replace(request: StrataAnalogRequest) {
    const body = await request.readJson<{ name: string }>();

    return { method: request.method, id: request.params["id"], name: body.name };
  }

  @Patch("/:id")
  async update(request: StrataAnalogRequest) {
    const body = await request.readJson<{ name: string }>();

    return { id: request.params["id"], name: body.name };
  }

  @Delete("/:id")
  remove(request: StrataAnalogRequest) {
    return { deleted: request.params["id"] };
  }
}

describe("registerControllers — HTTP methods on a real H3 v1 router", () => {
  it("routes each method on one path to its own handler only", async () => {
    const { router, send } = createNitroLikeApp();

    registerControllers(router, [MethodTableController]);

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await send(method, "/api/items");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        handler: method.toLowerCase(),
        method,
      });
    }
  });

  it("reads a JSON body on a POST route", async () => {
    const { router, send } = createNitroLikeApp();

    registerControllers(router, [ItemsController]);

    const response = await send("POST", "/api/items", { name: "Ada" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ method: "POST", name: "Ada" });
  });

  it("combines a route param and a JSON body on a PATCH route", async () => {
    const { router, send } = createNitroLikeApp();

    registerControllers(router, [ItemsController]);

    const response = await send("PATCH", "/api/items/42", { name: "Grace" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "42", name: "Grace" });
  });

  it("executes PUT and DELETE routes like any other method", async () => {
    const { router, send } = createNitroLikeApp();

    registerControllers(router, [ItemsController]);

    const put = await send("PUT", "/api/items/7", { name: "Linus" });
    const del = await send("DELETE", "/api/items/42");

    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({ method: "PUT", id: "7", name: "Linus" });
    expect(del.status).toBe(200);
    await expect(del.json()).resolves.toEqual({ deleted: "42" });
  });

  it("answers 405 for a method the path has no Strata route for", async () => {
    const { router, send } = createNitroLikeApp();

    registerControllers(router, [ItemsController]);

    // `/api/items` only has POST in ItemsController.
    expect((await send("GET", "/api/items")).status).toBe(405);
  });

  it("runs cleanups when a POST handler throws, through the same invocation path as GET", async () => {
    const log: string[] = [];

    @Controller("/api/failing")
    class FailingController {
      @Post()
      create() {
        log.push("handler");
        throw new Error("create failed");
      }
    }

    const options: RegisterControllersOptions = {
      controllerFactory: (Controller, { onCleanup }) => {
        onCleanup(() => {
          log.push("cleanup");
        });

        return new Controller();
      },
    };
    const { router, send } = createNitroLikeApp();

    registerControllers(router, [FailingController], options);

    const response = await send("POST", "/api/failing");

    expect(response.status).toBe(500);
    expect(log).toEqual(["handler", "cleanup"]);
  });

  it("reads a JSON body the runtime attached to a non-iterable Node request (Nitro on workerd)", async () => {
    const handlers: Array<(event: object) => unknown> = [];

    registerControllers(
      {
        add(_path, handler) {
          handlers.push(handler);
        },
      },
      [ItemsController],
    );

    // Shape of Nitro's cloudflare-pages call: node-mock-http's IncomingMessage
    // carries the payload on `body` and cannot be async-iterated.
    const nodeRequest = (body: unknown) => ({
      method: "PATCH",
      url: "/api/items/42",
      headers: { "content-type": "application/json" },
      body,
      [Symbol.asyncIterator](): AsyncIterator<string> {
        throw new Error("Readable.asyncIterator is not implemented yet!");
      },
    });
    const update = handlers[2];
    const payload = JSON.stringify({ name: "Grace" });

    expect(update).toBeDefined();

    for (const body of [payload, new TextEncoder().encode(payload), new Response(payload).body]) {
      await expect(
        update?.({
          method: "PATCH",
          path: "/api/items/42",
          context: { params: { id: "42" } },
          node: { req: nodeRequest(body) },
        }),
      ).resolves.toEqual({ id: "42", name: "Grace" });
    }
  });
});
