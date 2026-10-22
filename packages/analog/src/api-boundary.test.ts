import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { StrataAnalogHttpError } from "./http-error.js";
import type {
  ControllerClass,
  NitroRouter,
  RegisterControllersOptions,
} from "./register-controllers.js";
import { registerControllers } from "./register-controllers.js";
import { jsonResponse } from "./responses.js";

/**
 * Nitro's own composition: a preemptive router, native routes on it, and the
 * renderer registered last as a `/**` catch-all that answers HTML — which is
 * what an unmatched `/api/*` request reaches without the boundary.
 */
function createNitroLikeApp(native: (router: ReturnType<typeof createRouter>) => void = () => {}) {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  native(router);
  router.add(
    "/**",
    defineEventHandler(
      () =>
        new Response("<!doctype html><title>Analog</title>", {
          headers: { "content-type": "text/html" },
        }),
    ),
  );
  app.use(router.handler);

  const handle = toWebHandler(app);

  return {
    router,
    request: (path: string, init?: RequestInit) =>
      handle(new Request(`http://localhost${path}`, init)),
  };
}

const calls: string[] = [];

@Controller("/api/products")
class ProductsController {
  @Get("/:id")
  find() {
    calls.push("find");
    return { id: "42", name: "Widget" };
  }

  @Post()
  create() {
    calls.push("create");
    return jsonResponse({ id: "43" }, { status: 201 });
  }

  @Patch("/:id")
  update() {
    calls.push("update");
    return { id: "42", name: "Renamed" };
  }

  @Delete("/:id")
  remove() {
    calls.push("remove");
    return new Response(null, { status: 204 });
  }
}

@Controller("/api/orders")
class OrdersController {
  @Get()
  list() {
    return [];
  }
}

const boundary = { prefixes: ["/api"] } as const;

describe("apiBoundary — 404", () => {
  it("answers an unknown path below an owned prefix with a safe JSON 404 instead of the HTML renderer", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    for (const path of [
      "/api/nonexistent",
      "/api/products/42/unknown?token=SECRET_QUERY_CANARY",
      "/api",
      "/api/",
      "/api/products//42",
      "/api/Products/42",
      "/api/products/%C3%A9/extra/segments",
    ]) {
      const response = await request(path);
      const body = await response.text();

      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(body, path).toBe('{"error":"not_found"}');
    }
  });

  it("without the boundary the same request falls through to the HTML renderer (negative control)", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController]);

    const response = await request("/api/nonexistent");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html");
  });

  it("leaves pages, assets and prefix look-alikes to the renderer", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    for (const path of [
      "/",
      "/products",
      "/apix",
      "/api-docs",
      "/assets/app.js",
      "/about?x=/api",
    ]) {
      const response = await request(path);

      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("text/html");
    }
  });

  it("keeps an application 404 distinct from a missing route: the handler runs, the factory is not skipped", async () => {
    let constructed = 0;
    @Controller("/api/items")
    class ItemsController {
      constructor() {
        constructed += 1;
      }

      @Get("/:id")
      find() {
        throw new StrataAnalogHttpError(404, "not_found", "private canary");
      }
    }
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ItemsController], { apiBoundary: boundary });

    const application = await request("/api/items/9");
    const missing = await request("/api/items/9/missing");

    expect(constructed).toBe(1);
    expect(application.status).toBe(404);
    expect(await application.text()).toBe('{"error":"not_found"}');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('{"error":"not_found"}');
  });

  it("does not construct a controller, run guards or interceptors for a framework 404/405", async () => {
    const seen: string[] = [];
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: boundary,
      guards: [
        () => {
          seen.push("guard");
          return { allow: true };
        },
      ],
      interceptors: [
        (_context, next) => {
          seen.push("interceptor");
          return next();
        },
      ],
      controllerFactory(controller) {
        seen.push("factory");
        return new controller();
      },
    });

    await request("/api/nope");
    await request("/api/products/42", { method: "PUT" });

    expect(seen).toEqual([]);
  });
});

describe("apiBoundary — 405 and Allow", () => {
  it("answers a known path with an unsupported method with 405 and a stable Allow derived from the routes", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    const response = await request("/api/products/42?x=1", { method: "PUT" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PATCH, DELETE");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"error":"method_not_allowed"}');

    const collection = await request("/api/products", { method: "DELETE" });

    expect(collection.status).toBe(405);
    expect(collection.headers.get("allow")).toBe("POST");
  });

  it("handles an unusual method the same way", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    const response = await request("/api/products/42", { method: "PROPFIND" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PATCH, DELETE");
  });

  it("never answers 405 for a path no route matches", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    for (const path of ["/api/products/42/x", "/api/product/42", "/api/orders"]) {
      const response = await request(path, { method: "PUT" });

      expect(response.status, path).toBe(404);
      expect(response.headers.get("allow"), path).toBeNull();
    }
  });

  it("is not triggered by an invalid resource id: the matched route decides", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    const response = await request("/api/products/not-a-route");

    expect(response.status).toBe(200);
    expect(calls.at(-1)).toBe("find");
  });

  it("unions the methods of every route that matches, as Nitro's method fallthrough does", async () => {
    @Controller("/api/things")
    class ThingsController {
      @Post("/new")
      create() {
        return { created: true };
      }

      @Get("/:id")
      find() {
        return { id: "x" };
      }
    }
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ThingsController], { apiBoundary: boundary });

    const response = await request("/api/things/new", { method: "PUT" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
    // Nitro's own fallthrough: GET on the static path reaches the param route.
    expect((await request("/api/things/new")).status).toBe(200);
  });

  it("serves a route Nitro's non-backtracking router dead-ends on, instead of contradicting the route table", async () => {
    @Controller("/api/a")
    class DeadEndController {
      @Get("/new/y")
      staticLeaf() {
        return { route: "static-leaf" };
      }

      @Get("/:id/x")
      paramLeaf(request: { params: Readonly<Record<string, string>> }) {
        return { route: "param-leaf", id: request.params["id"] };
      }
    }
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [DeadEndController], { apiBoundary: boundary });

    expect(await (await request("/api/a/new/y")).json()).toEqual({ route: "static-leaf" });
    expect(await (await request("/api/a/q/x")).json()).toEqual({ route: "param-leaf", id: "q" });
    expect(await (await request("/api/a/new/x")).json()).toEqual({
      route: "param-leaf",
      id: "new",
    });
    expect((await request("/api/a/new/x", { method: "PUT" })).status).toBe(405);
  });
});

describe("apiBoundary — HEAD", () => {
  it("derives HEAD from the GET route: one handler call, guards run, cleanup once, no body", async () => {
    const seen: string[] = [];
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: boundary,
      guards: [
        ({ request: strataRequest }) => {
          seen.push(`guard:${strataRequest.method}`);
          return { allow: true };
        },
      ],
      controllerFactory(controller, context) {
        context.onCleanup(() => {
          seen.push("cleanup");
        });
        seen.push("factory");
        return new controller();
      },
    });
    calls.length = 0;

    const response = await request("/api/products/42", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe("");
    expect(calls).toEqual(["find"]);
    expect(seen).toEqual(["guard:HEAD", "factory", "cleanup"]);
  });

  it("does not run the guard bypass: a denied GET is a denied HEAD", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: boundary,
      guards: [() => ({ allow: false, status: 401 })],
    });
    calls.length = 0;

    const response = await request("/api/products/42", { method: "HEAD" });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(calls).toEqual([]);
  });

  it("never maps HEAD to a mutating route", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });
    calls.length = 0;

    const response = await request("/api/products", { method: "HEAD" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(calls).toEqual([]);
  });

  it("returns the status and headers of a Response result without reading a streaming body", async () => {
    let pulled = false;
    @Controller("/api/stream")
    class StreamController {
      @Get()
      stream() {
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                pulled = true;
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 200, headers: { "content-type": "text/plain", "x-custom": "yes" } },
        );
      }
    }
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [StreamController], { apiBoundary: boundary });

    const response = await request("/api/stream", { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-custom")).toBe("yes");
    expect(await response.text()).toBe("");
    expect(pulled).toBe(false);

    // Control: the same route does pull its stream when a GET reads the body.
    await (await request("/api/stream")).text();

    expect(pulled).toBe(true);
  });

  it('answers HEAD like any unsupported method when head is "off"', async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: { prefixes: ["/api"], head: "off" },
    });

    const response = await request("/api/products/42", { method: "HEAD" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE");
  });
});

describe("apiBoundary — OPTIONS", () => {
  it("is off by default: OPTIONS is a 405 and not advertised", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    const response = await request("/api/products/42", { method: "OPTIONS" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PATCH, DELETE");
  });

  it('answers a plain OPTIONS with 204 and Allow when options is "allow", without any CORS header', async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: { prefixes: ["/api"], options: "allow" },
    });

    const response = await request("/api/products/42", { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PATCH, DELETE, OPTIONS");
    expect(await response.text()).toBe("");
    for (const [name] of response.headers) expect(name).not.toMatch(/^access-control-/);

    const unsupported = await request("/api/products/42", { method: "PUT" });

    expect(unsupported.headers.get("allow")).toBe("GET, HEAD, PATCH, DELETE, OPTIONS");
  });

  it("never answers a CORS preflight, and never manufactures CORS headers", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: { prefixes: ["/api"], options: "allow" },
    });

    const response = await request("/api/products/42", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "DELETE" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PATCH, DELETE");
    for (const [name] of response.headers) expect(name).not.toMatch(/^access-control-/);
  });

  it("answers OPTIONS on an unknown path with 404", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], {
      apiBoundary: { prefixes: ["/api"], options: "allow" },
    });

    expect((await request("/api/nope", { method: "OPTIONS" })).status).toBe(404);
  });
});

describe("apiBoundary — native Nitro routes", () => {
  const native = (router: ReturnType<typeof createRouter>) => {
    router.get(
      "/api/health",
      defineEventHandler(() => ({ status: "ok", native: true })),
    );
    router.get(
      "/api/files/**",
      defineEventHandler(() => ({ native: "files" })),
    );
    router.post(
      "/api/hooks/:id",
      defineEventHandler(() => ({ native: "hook" })),
    );
  };

  it("never shadows a native route that handles the request", async () => {
    const { router, request } = createNitroLikeApp(native);
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    expect(await (await request("/api/health")).json()).toEqual({ status: "ok", native: true });
    expect(await (await request("/api/health/")).json()).toEqual({ status: "ok", native: true });
    expect(await (await request("/api/files/a/b/c")).json()).toEqual({ native: "files" });
    expect(await (await request("/api/hooks/9", { method: "POST" })).json()).toEqual({
      native: "hook",
    });
  });

  it("owns the wrong-method answer for undeclared native routes only as a 404 — and declared ones as 405", async () => {
    const undeclared = createNitroLikeApp(native);
    registerControllers(undeclared.router, [ProductsController], { apiBoundary: boundary });

    expect((await undeclared.request("/api/health", { method: "POST" })).status).toBe(404);

    const declared = createNitroLikeApp(native);
    registerControllers(declared.router, [ProductsController], {
      apiBoundary: {
        prefixes: ["/api"],
        nativeRoutes: [
          { path: "/api/health", methods: ["GET"] },
          { path: "/api/hooks/:id", methods: ["POST"] },
        ],
      },
    });

    const response = await declared.request("/api/health", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect((await declared.request("/api/hooks/9", { method: "GET" })).headers.get("allow")).toBe(
      "POST",
    );
    expect(await (await declared.request("/api/health")).json()).toEqual({
      status: "ok",
      native: true,
    });
  });

  it("leaves Analog's server-function dispatch route (/_analog/fn/:id) and its 404 to Analog", async () => {
    const { router, request } = createNitroLikeApp((nitro) => {
      nitro.post(
        "/_analog/fn/:id",
        defineEventHandler(() => ({ serverFn: true })),
      );
    });
    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    const called = await request("/_analog/fn/abc123", { method: "POST" });

    expect(called.status).toBe(200);
    expect(await called.json()).toEqual({ serverFn: true });
    // Not an owned prefix: an unknown path there is still the renderer's, not a JSON 404.
    expect((await request("/_analog/other")).headers.get("content-type")).toBe("text/html");
  });

  it("registers no handler that hides a native route registered later on the same router", async () => {
    const { router, request } = createNitroLikeApp();
    registerControllers(router, [ProductsController], { apiBoundary: boundary });
    router.get(
      "/api/late",
      defineEventHandler(() => ({ late: true })),
    );

    expect(await (await request("/api/late")).json()).toEqual({ late: true });
  });
});

describe("apiBoundary — registration", () => {
  const rejected = (
    options: RegisterControllersOptions,
    controllers: readonly ControllerClass[] = [ProductsController],
  ) => {
    const { router } = createNitroLikeApp();
    const added: string[] = [];
    const recording: NitroRouter = {
      add(path, handler, method) {
        added.push(`${String(method)} ${path}`);
        router.add(path, defineEventHandler(handler as never), method);
      },
    };

    expect(() => registerControllers(recording, controllers, options)).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(added).toEqual([]);
  };

  it.each([
    ["no prefixes", { prefixes: [] }],
    ["the site root", { prefixes: ["/"] }],
    ["an empty prefix", { prefixes: [""] }],
    ["a relative prefix", { prefixes: ["api"] }],
    ["a wildcard", { prefixes: ["/api/**"] }],
    ["a parameter", { prefixes: ["/:tenant"] }],
    ["a repeated separator", { prefixes: ["/api//v1"] }],
    ["a query", { prefixes: ["/api?x=1"] }],
    ["a non-string prefix", { prefixes: [42] }],
    ["a duplicate prefix", { prefixes: ["/api", "/api/"] }],
    ["overlapping prefixes", { prefixes: ["/api", "/api/v2"] }],
    ["an unknown option", { prefixes: ["/api"], cors: true }],
    ["a bad head policy", { prefixes: ["/api"], head: "yes" }],
    ["a bad options policy", { prefixes: ["/api"], options: true }],
    ["non-array native routes", { prefixes: ["/api"], nativeRoutes: {} }],
    [
      "a native route outside the prefixes",
      { prefixes: ["/api"], nativeRoutes: [{ path: "/x", methods: ["GET"] }] },
    ],
    [
      "a native wildcard",
      { prefixes: ["/api"], nativeRoutes: [{ path: "/api/**", methods: ["GET"] }] },
    ],
    [
      "a native route without methods",
      { prefixes: ["/api"], nativeRoutes: [{ path: "/api/x", methods: [] }] },
    ],
    [
      "a native invalid method",
      { prefixes: ["/api"], nativeRoutes: [{ path: "/api/x", methods: ["TRACE"] }] },
    ],
    [
      "a native route that collides with a Strata route",
      { prefixes: ["/api"], nativeRoutes: [{ path: "/api/orders", methods: ["GET"] }] },
    ],
    ["a non-object boundary", null],
  ])("rejects %s before touching the router", (_name, apiBoundary) => {
    rejected({ apiBoundary: apiBoundary as never }, [OrdersController]);
  });

  it("rejects Strata routes below an owned prefix that the boundary cannot match", () => {
    @Controller("/api/files")
    class WildcardController {
      @Get("/**")
      all() {
        return {};
      }
    }
    @Controller("/api/mixed")
    class MixedController {
      @Get("/file-:id")
      partial() {
        return {};
      }
    }
    @Controller("/api/dup")
    class DuplicateNameController {
      @Get("/:id/:id")
      twice() {
        return {};
      }
    }

    rejected({ apiBoundary: boundary }, [WildcardController]);
    rejected({ apiBoundary: boundary }, [MixedController]);
    rejected({ apiBoundary: boundary }, [DuplicateNameController]);
  });

  it("rejects routes that differ only in parameter names", () => {
    @Controller("/api/p")
    class FirstController {
      @Get("/:id")
      one() {
        return {};
      }
    }
    @Controller("/api/p")
    class SecondController {
      @Get("/:pid")
      two() {
        return {};
      }
    }

    rejected({ apiBoundary: boundary }, [FirstController, SecondController]);
  });

  it("accepts GET and POST on one path, and wildcard routes outside any owned prefix", () => {
    @Controller("/api/same")
    class SameController {
      @Get()
      read() {
        return {};
      }

      @Post()
      write() {
        return {};
      }
    }
    @Controller("/pages")
    class OutsideController {
      @Get("/**")
      all() {
        return {};
      }
    }
    const { router } = createNitroLikeApp();

    expect(() =>
      registerControllers(router, [SameController, OutsideController], { apiBoundary: boundary }),
    ).not.toThrow();
  });

  it("still rejects duplicate Strata routes and duplicate controllers", () => {
    const { router } = createNitroLikeApp();

    expect(() =>
      registerControllers(router, [ProductsController, ProductsController], {
        apiBoundary: boundary,
      }),
    ).toThrow(/Duplicate Strata route/);

    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    expect(() => registerControllers(router, [ProductsController])).toThrow(
      /already registered on this router/,
    );
  });

  it("shares one boundary across batches: later controllers are known, a repeated prefix is idempotent", async () => {
    const { router, request } = createNitroLikeApp();

    registerControllers(router, [ProductsController], { apiBoundary: boundary });
    registerControllers(router, [OrdersController], { apiBoundary: { prefixes: ["/api/"] } });

    expect((await request("/api/orders", { method: "PUT" })).headers.get("allow")).toBe(
      "GET, HEAD",
    );
    expect((await request("/api/products/42", { method: "PUT" })).headers.get("allow")).toBe(
      "GET, HEAD, PATCH, DELETE",
    );
    expect((await request("/api/zzz")).status).toBe(404);
  });

  it("covers routes registered before the prefix was declared", async () => {
    const { router, request } = createNitroLikeApp();

    registerControllers(router, [ProductsController]);
    registerControllers(router, [OrdersController], { apiBoundary: boundary });

    expect((await request("/api/products/42", { method: "PUT" })).status).toBe(405);
  });

  it("rejects a later call that changes the policy of an owned prefix, or overlaps it", () => {
    const { router } = createNitroLikeApp();

    registerControllers(router, [ProductsController], { apiBoundary: boundary });

    expect(() =>
      registerControllers(router, [OrdersController], {
        apiBoundary: { prefixes: ["/api"], head: "off" },
      }),
    ).toThrow(/different head\/options policy/);
    expect(() =>
      registerControllers(router, [OrdersController], { apiBoundary: { prefixes: ["/api/v2"] } }),
    ).toThrow(/overlaps/);
    expect(() => registerControllers(router, [OrdersController])).not.toThrow();
  });

  it("validates routes added by a later call without apiBoundary, and native declarations from earlier calls", () => {
    @Controller("/api/late")
    class LateWildcardController {
      @Get("/**")
      all() {
        return {};
      }
    }
    @Controller("/api")
    class HealthController {
      @Get("/health")
      health() {
        return {};
      }
    }
    const { router } = createNitroLikeApp();

    registerControllers(router, [ProductsController], {
      apiBoundary: {
        prefixes: ["/api"],
        nativeRoutes: [{ path: "/api/health", methods: ["GET"] }],
      },
    });

    expect(() => registerControllers(router, [LateWildcardController])).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(() => registerControllers(router, [HealthController])).toThrow(
      /also registers as a Strata route/,
    );
    // Nothing from the rejected batches was registered.
    expect(() => registerControllers(router, [OrdersController])).not.toThrow();
  });

  it("keeps routers and server lifetimes independent", async () => {
    const first = createNitroLikeApp();
    const second = createNitroLikeApp();

    registerControllers(first.router, [ProductsController], { apiBoundary: boundary });
    registerControllers(second.router, [OrdersController]);

    expect((await first.request("/api/orders")).status).toBe(404);
    expect((await second.request("/api/products/42")).headers.get("content-type")).toBe(
      "text/html",
    );
    expect(() =>
      registerControllers(second.router, [ProductsController], { apiBoundary: boundary }),
    ).not.toThrow();
  });
});

describe("apiBoundary — conformance with Nitro's router", () => {
  @Controller("/api")
  class CorpusController {
    @Get("/a/:id")
    a() {
      return { route: "GET a/:id" };
    }

    @Patch("/a/:id")
    aPatch() {
      return { route: "PATCH a/:id" };
    }

    @Get("/a/new")
    aNew() {
      return { route: "GET a/new" };
    }

    @Post("/a/new")
    aNewPost() {
      return { route: "POST a/new" };
    }

    @Get("/b/:id/c")
    bc() {
      return { route: "GET b/:id/c" };
    }

    @Delete("/b/:id")
    b() {
      return { route: "DELETE b/:id" };
    }

    @Get("/list")
    list() {
      return { route: "GET list" };
    }
  }

  const paths = [
    "/api/a/1",
    "/api/a/1/",
    "/api/a/new",
    "/api/a/%34%32",
    "/api/a/%2F",
    "/api/a/é",
    "/api/a/1?x=1",
    "/api/a//1",
    "/api/a/1/2",
    "/api/A/1",
    "/api/b/1/c",
    "/api/b/1",
    "/api/b/1/c/d",
    "/api/list",
    "/api/list/",
    "/api/list/x",
    "/api/missing",
    "/api",
    "/api/",
  ];
  const methods = ["GET", "POST", "PATCH", "DELETE", "PUT"];

  it("never contradicts the route Nitro itself serves, and serves exactly the matching routes otherwise", async () => {
    // Reference: Nitro's router with the same Strata routes and no boundary.
    const reference = createNitroLikeApp();
    registerControllers(reference.router, [CorpusController]);
    const owned = createNitroLikeApp();
    registerControllers(owned.router, [CorpusController], { apiBoundary: boundary });

    for (const method of methods) {
      for (const path of paths) {
        const expected = await reference.request(path, { method });
        const actual = await owned.request(path, { method });
        const served = expected.headers.get("content-type")?.includes("json");

        if (served) {
          expect(await actual.text(), `${method} ${path}`).toBe(await expected.text());
        } else {
          // Not served by Nitro: the boundary answers 404/405 (or serves a route Nitro's
          // router could not reach), and never falls through to HTML.
          expect(actual.headers.get("content-type"), `${method} ${path}`).toBe(
            "application/json; charset=utf-8",
          );
          expect([200, 404, 405], `${method} ${path}`).toContain(actual.status);
        }
      }
    }
  });
});
