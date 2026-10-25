import { Controller, Get, Post } from "@strata-sc/core";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { StrataAnalogConfigurationError } from "./errors.js";
import { StrataAnalogHttpError } from "./http-error.js";
import type {
  NitroRouter,
  StrataAnalogInterceptor,
  StrataAnalogRequest,
} from "./register-controllers.js";
import { registerControllers } from "./register-controllers.js";
import { jsonResponse } from "./responses.js";

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
  it("maps expected application errors to safe no-store responses after successful cleanup", async () => {
    const { router, request } = createNitroLikeApp();
    let cleanupCalls = 0;
    @Controller("/application-error")
    class ApplicationErrorController {
      @Get()
      get() {
        throw new StrataAnalogHttpError(404, "not_found", "private canary in message", {
          cause: new Error("private canary in cause"),
        });
      }
    }
    registerControllers(router, [ApplicationErrorController], {
      controllerFactory(controller, context) {
        context.onCleanup(() => {
          cleanupCalls += 1;
        });
        return new controller();
      },
    });

    const response = await request("/application-error");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe('{"error":"not_found"}');
    expect(cleanupCalls).toBe(1);
  });

  it("composes application errors and response helpers with timing and outcome interceptors", async () => {
    const { router, request } = createNitroLikeApp();
    const events: string[] = [];
    @Controller("/interceptor-http-contract")
    class InterceptorHttpContractController {
      @Get("/error")
      fail() {
        throw new StrataAnalogHttpError(409, "conflict", "private message");
      }

      @Get("/mapped")
      success() {
        return { value: 2 };
      }
    }
    registerControllers(router, [InterceptorHttpContractController], {
      interceptors: [
        async (_context, next) => {
          events.push("timing:start");
          try {
            return await next();
          } finally {
            events.push("timing:end");
          }
        },
        async (_context, next) => {
          try {
            const result = await next();
            events.push("outcome:success");
            return result;
          } catch (error) {
            events.push(
              `outcome:error:${error instanceof StrataAnalogHttpError ? error.code : "unknown"}`,
            );
            throw error;
          }
        },
        async (_context, next) => {
          const result = await next();
          return jsonResponse({ mapped: result }, { status: 202, headers: { "x-mapped": "yes" } });
        },
      ],
    });

    const error = await request("/interceptor-http-contract/error");
    expect(error.status).toBe(409);
    expect(error.headers.get("cache-control")).toBe("no-store");
    expect(await error.text()).toBe('{"error":"conflict"}');
    expect(events).toEqual(["timing:start", "outcome:error:conflict", "timing:end"]);

    events.length = 0;
    const mapped = await request("/interceptor-http-contract/mapped");
    expect(mapped.status).toBe(202);
    expect(mapped.headers.get("x-mapped")).toBe("yes");
    await expect(mapped.json()).resolves.toEqual({ mapped: { value: 2 } });
    expect(events).toEqual(["timing:start", "outcome:success", "timing:end"]);
  });

  it("isolates a rendezvous-synchronized 24-request mixed HTTP matrix", async () => {
    const { router, handle } = createNitroLikeApp();
    let releaseRendezvous!: () => void;
    const rendezvous = new Promise<void>((resolve) => {
      releaseRendezvous = resolve;
    });
    let guardsEntered = 0;
    let guardCleanups = 0;
    let factoryCalls = 0;
    let factoryCleanups = 0;
    let handlerCalls = 0;
    let interceptorEntries = 0;
    let interceptorUnwinds = 0;
    const privateCanary = "PRIVATE_MIXED_HTTP_CANARY";

    @Controller("/mixed-http")
    class MixedHttpController {
      @Get("/:kind")
      async run(request: StrataAnalogRequest) {
        handlerCalls += 1;
        const kind = request.params["kind"] ?? "";
        const requestId = request.headers.get("x-request-id") ?? "missing";
        if (kind === "not-found") throw new StrataAnalogHttpError(404, "not_found", privateCanary);
        if (kind === "conflict") throw new StrataAnalogHttpError(409, "conflict");
        if (kind === "validation") {
          await request.validateQuery(z.object({ required: z.string() }));
        }
        if (kind === "handler-error") throw new Error(privateCanary);
        if (kind === "cleanup-failure") throw new StrataAnalogHttpError(404, "not_found");
        if (kind === "unavailable") throw new StrataAnalogHttpError(503, "service_unavailable");
        if (kind === "mapped") return jsonResponse({ kind, requestId }, { status: 201 });
        return { kind, requestId };
      }
    }

    registerControllers(router, [MixedHttpController], {
      guards: [
        async ({ request, onCleanup }) => {
          onCleanup(() => {
            guardCleanups += 1;
          });
          guardsEntered += 1;
          if (guardsEntered === 24) releaseRendezvous();
          await rendezvous;
          const kind = request.params["kind"];
          if (kind === "unauthorized") return { allow: false as const, status: 401 as const };
          if (kind === "forbidden") return { allow: false as const, status: 403 as const };
          return { allow: true as const };
        },
      ],
      controllerFactory(controller, { request, onCleanup }) {
        factoryCalls += 1;
        onCleanup(() => {
          factoryCleanups += 1;
          if (request.params["kind"] === "cleanup-failure") throw new Error(privateCanary);
        });
        return new controller();
      },
      interceptors: [
        async (_context, next) => {
          interceptorEntries += 1;
          try {
            const result = await next();
            if (result instanceof Response) return result;
            return jsonResponse(result, { headers: { "x-mixed-mapped": "yes" } });
          } finally {
            interceptorUnwinds += 1;
          }
        },
      ],
    });

    const kinds = [
      "success",
      "unauthorized",
      "forbidden",
      "not-found",
      "conflict",
      "validation",
      "handler-error",
      "cleanup-failure",
      "mapped",
      "unavailable",
    ];
    const counts = [3, 3, 3, 3, 3, 3, 2, 2, 1, 1];
    const requests = kinds.flatMap((kind, kindIndex) =>
      Array.from({ length: counts[kindIndex] ?? 0 }, (_, index) => {
        const requestId = `${kind}-${index}`;
        return handle(
          new Request(`http://localhost/mixed-http/${kind}`, {
            headers: { "x-request-id": requestId },
          }),
        ).then(async (response) => ({
          kind,
          requestId,
          status: response.status,
          body: await response.text(),
          mapped: response.headers.get("x-mixed-mapped"),
          cache: response.headers.get("cache-control"),
        }));
      }),
    );
    const results = await Promise.all(requests);

    expect(results).toHaveLength(24);
    expect(guardsEntered).toBe(24);
    expect(guardCleanups).toBe(24);
    expect(factoryCalls).toBe(18);
    expect(factoryCleanups).toBe(18);
    expect(handlerCalls).toBe(18);
    expect(interceptorEntries).toBe(18);
    expect(interceptorUnwinds).toBe(18);
    expect(
      new Set(results.filter(({ status }) => status === 200).map(({ requestId }) => requestId))
        .size,
    ).toBe(3);
    for (const result of results) {
      const expectedStatus: Record<string, number> = {
        success: 200,
        unauthorized: 401,
        forbidden: 403,
        "not-found": 404,
        conflict: 409,
        validation: 400,
        "handler-error": 500,
        "cleanup-failure": 500,
        mapped: 201,
        unavailable: 503,
      };
      expect(result.status).toBe(expectedStatus[result.kind]);
      expect(result.body).not.toContain(privateCanary);
      if (result.kind === "not-found") expect(result.body).toBe('{"error":"not_found"}');
      if (result.kind === "conflict") expect(result.body).toBe('{"error":"conflict"}');
      if (result.kind === "validation") {
        expect(result.body).toBe('{"error":"invalid_request","source":"query"}');
      }
      if (result.kind === "unauthorized") expect(result.body).toBe('{"error":"unauthorized"}');
      if (result.kind === "forbidden") expect(result.body).toBe('{"error":"forbidden"}');
      if (result.kind === "cleanup-failure") expect(result.body).not.toContain("not_found");
      if (result.kind === "success") {
        expect(result.body).toBe(JSON.stringify({ kind: "success", requestId: result.requestId }));
        expect(result.mapped).toBe("yes");
      }
      if (result.kind === "mapped") {
        expect(result.body).toBe(JSON.stringify({ kind: "mapped", requestId: result.requestId }));
        expect(result.mapped).toBeNull();
      }
    }
  });

  it("does not hide cleanup failures behind expected application errors", async () => {
    const { router, request } = createNitroLikeApp();
    const cleanupCanary = new Error("private cleanup canary");
    @Controller("/application-error-cleanup-failure")
    class ApplicationErrorCleanupFailureController {
      @Get()
      get() {
        throw new StrataAnalogHttpError(404, "not_found");
      }
    }
    registerControllers(router, [ApplicationErrorCleanupFailureController], {
      controllerFactory(controller, context) {
        context.onCleanup(() => {
          throw cleanupCanary;
        });
        return new controller();
      },
    });

    const response = await request("/application-error-cleanup-failure");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("not_found");
    expect(body).not.toContain("private cleanup canary");
  });

  it("rejects unsupported application error status and malformed codes", () => {
    expect(
      [400, 404, 409, 422, 429, 503].map(
        (status) => new StrataAnalogHttpError(status as 400, "stable_code").status,
      ),
    ).toEqual([400, 404, 409, 422, 429, 503]);
    expect(() => new StrataAnalogHttpError(401 as 400, "unauthorized")).toThrow(TypeError);
    expect(() => new StrataAnalogHttpError(404, "Not Found")).toThrow(TypeError);
  });

  it("wraps controller execution in ordered interceptors and transforms results", async () => {
    const { router, request } = createNitroLikeApp();
    const events: string[] = [];
    @Controller("/intercepted")
    class InterceptedController {
      @Get() get() {
        events.push("handler");
        return { value: 2 };
      }
    }
    registerControllers(router, [InterceptedController], {
      guards: [
        ({ onCleanup }) => {
          events.push("guard");
          onCleanup(() => {
            events.push("cleanup guard");
          });
          return { allow: true as const };
        },
      ],
      interceptors: [
        async ({ onCleanup }, next) => {
          events.push("A before");
          onCleanup(() => {
            events.push("cleanup A");
          });
          const value = (await next()) as { value: number };
          events.push("A after");
          return { value: value.value + 1 };
        },
        async ({ onCleanup }, next) => {
          events.push("B before");
          onCleanup(() => {
            events.push("cleanup B");
          });
          const value = (await next()) as { value: number };
          events.push("B after");
          return value;
        },
      ],
      controllerFactory(controller, context) {
        context.onCleanup(() => {
          events.push("cleanup factory");
        });
        return new controller();
      },
    });
    const response = await request("/intercepted");
    expect(await response.json()).toEqual({ value: 3 });
    expect(events).toEqual([
      "guard",
      "A before",
      "B before",
      "handler",
      "B after",
      "A after",
      "cleanup factory",
      "cleanup B",
      "cleanup A",
      "cleanup guard",
    ]);
  });

  it("rejects interceptors that skip or call next more than once and still cleans up", async () => {
    let index = 0;
    let missingNextCleanup = 0;
    for (const interceptor of [
      (context: { onCleanup: (cleanup: () => void) => void }) => {
        context.onCleanup(() => {
          missingNextCleanup += 1;
        });
        return { okay: true };
      },
      async (_context: unknown, next: () => Promise<unknown>) => {
        await next();
        await next();
      },
      async (_context: unknown, next: () => Promise<unknown>) => {
        await Promise.all([next(), next()]);
      },
    ]) {
      const { router, request } = createNitroLikeApp();
      let cleanup = 0;
      let handlerCompleted = false;
      let cleanupBeforeHandler = false;
      missingNextCleanup = 0;
      const route = `/bad-interceptor-${index++}`;
      @Controller(route)
      class BadController {
        @Get() get() {
          handlerCompleted = true;
          return { private: true };
        }
      }
      registerControllers(router, [BadController], {
        interceptors: [interceptor as never],
        controllerFactory(controller, context) {
          context.onCleanup(() => {
            cleanup += 1;
            if (index === 3 && !handlerCompleted) cleanupBeforeHandler = true;
          });
          return new controller();
        },
      });
      const response = await request(route);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private");
      expect(index === 1 ? missingNextCleanup : cleanup).toBe(1);
      expect(cleanupBeforeHandler).toBe(false);
    }
  });

  it("passes a native Response through interceptors without changing its HTTP semantics", async () => {
    const { router, request } = createNitroLikeApp();
    @Controller("/native-response")
    class NativeResponseController {
      @Get()
      get() {
        return new Response("stream body", {
          status: 206,
          headers: { "content-type": "text/plain", "x-native": "preserved" },
        });
      }
    }
    registerControllers(router, [NativeResponseController], {
      interceptors: [async (_context, next) => next()],
    });
    const response = await request("/native-response");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("x-native")).toBe("preserved");
    expect(await response.text()).toBe("stream body");
  });

  it("snapshots interceptor configuration before route registration", async () => {
    const { router, request } = createNitroLikeApp();
    const events: string[] = [];
    @Controller("/interceptor-snapshot")
    class SnapshotController {
      @Get()
      get() {
        return { ok: true };
      }
    }
    const first: StrataAnalogInterceptor = async (_context, next) => {
      events.push("first");
      return next();
    };
    const interceptors: StrataAnalogInterceptor[] = [first];
    expect(() =>
      registerControllers(router, [SnapshotController], { interceptors: [null as never] }),
    ).toThrow(StrataAnalogConfigurationError);
    registerControllers(router, [SnapshotController], { interceptors });
    interceptors[0] = () => {
      events.push("mutated");
      return undefined;
    };
    await request("/interceptor-snapshot");
    expect(events).toEqual(["first"]);
  });

  it("rejects a late next() call without starting downstream work again", async () => {
    const { router, request } = createNitroLikeApp();
    let handlerCalls = 0;
    let lateError: unknown;
    @Controller("/late-next")
    class LateNextController {
      @Get()
      get() {
        handlerCalls += 1;
        return { ok: true };
      }
    }
    registerControllers(router, [LateNextController], {
      interceptors: [
        async (_context, next) => {
          const result = await next();
          setTimeout(() => {
            void next().catch((error: unknown) => {
              lateError = error;
            });
          }, 0);
          return result;
        },
      ],
    });
    const response = await request("/late-next");
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateError).toBeInstanceOf(StrataAnalogConfigurationError);
    expect(handlerCalls).toBe(1);
  });

  it("runs guards sequentially before construction and settles safe denials after LIFO cleanup", async () => {
    const { router, request } = createNitroLikeApp();
    const events: string[] = [];
    let constructed = 0;
    @Controller("/guarded")
    class GuardedController {
      @Get("/:id")
      get() {
        events.push("handler");
        return { ok: true };
      }
    }
    const guards = [
      ({
        route,
        onCleanup,
      }: {
        route: { path: string };
        onCleanup: (cleanup: () => void) => void;
      }) => {
        events.push(`first:${route.path}`);
        onCleanup(() => {
          events.push("cleanup-first");
        });
        return { allow: true as const };
      },
      async ({ onCleanup }: { onCleanup: (cleanup: () => void | Promise<void>) => void }) => {
        await Promise.resolve();
        events.push("second");
        onCleanup(async () => {
          await Promise.resolve();
          events.push("cleanup-second");
        });
        return { allow: false as const, status: 401 as const };
      },
      () => {
        events.push("must-not-run");
        return { allow: true as const };
      },
    ];
    registerControllers(router, [GuardedController], {
      guards,
      controllerFactory(controller) {
        constructed += 1;
        return new controller();
      },
    });
    guards.pop();

    const response = await request("/guarded/42");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(events).toEqual(["first:/guarded/:id", "second", "cleanup-second", "cleanup-first"]);
    expect(constructed).toBe(0);
  });

  it("rejects malformed guard decisions and validates guard configuration atomically", async () => {
    const { router, request } = createNitroLikeApp();
    @Controller("/malformed")
    class MalformedController {
      @Get() get() {
        return { private: true };
      }

      @Get("/inherited") inherited() {
        return { private: true };
      }
    }
    expect(() =>
      registerControllers(router, [MalformedController], { guards: [null as never] }),
    ).toThrow(StrataAnalogConfigurationError);
    registerControllers(router, [MalformedController], {
      guards: [
        ({ route }) =>
          route.handler === "inherited"
            ? (Object.create({ allow: true }) as { readonly allow: true })
            : (undefined as never),
      ],
    });
    const response = await request("/malformed");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
    const inheritedDecision = await request("/malformed/inherited");
    expect(inheritedDecision.status).toBe(500);
  });

  it("allows guards to validate params before construction and preserves cleanup failures on denial", async () => {
    const { router, request } = createNitroLikeApp();
    let factories = 0;
    let cleanups = 0;
    @Controller("/guard-params")
    class GuardParamsController {
      @Get("/:id") get() {
        return { ok: true };
      }
    }
    registerControllers(router, [GuardParamsController], {
      guards: [
        async ({ request: current, onCleanup }) => {
          onCleanup(async () => {
            await Promise.resolve();
            cleanups += 1;
            if (current.params["id"] === "p1") throw new Error("private cleanup failure");
          });
          const { id } = await current.validateParams(
            z.object({ id: z.string().regex(/^p\\d+$/) }),
          );
          return id === "p1"
            ? { allow: false as const, status: 403 as const }
            : { allow: true as const };
        },
      ],
      controllerFactory(controller) {
        factories += 1;
        return new controller();
      },
    });
    const invalid = await request("/guard-params/nope");
    expect(invalid.status).toBe(400);
    expect(cleanups).toBe(1);
    expect(factories).toBe(0);

    const denial = await request("/guard-params/p1");
    expect(denial.status).toBe(500);
    expect(await denial.text()).not.toContain("private cleanup failure");
    expect(cleanups).toBe(2);
    expect(factories).toBe(0);
  });

  it("runs cleanup and preserves unexpected guard failures without treating them as denials", async () => {
    const { router, request } = createNitroLikeApp();
    const order: string[] = [];
    let factories = 0;
    @Controller("/guard-failure")
    class GuardFailureController {
      @Get() get() {
        order.push("handler");
        return { ok: true };
      }
    }
    registerControllers(router, [GuardFailureController], {
      guards: [
        ({ onCleanup }) => {
          onCleanup(() => {
            order.push("cleanup-one");
          });
          return { allow: true };
        },
        async ({ onCleanup }) => {
          onCleanup(async () => {
            await Promise.resolve();
            order.push("cleanup-two");
          });
          await Promise.resolve();
          throw new Error("private guard exception");
        },
      ],
      controllerFactory(controller) {
        factories += 1;
        return new controller();
      },
    });
    const response = await request("/guard-failure");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).not.toBe("no-store");
    expect(await response.text()).not.toContain("private guard exception");
    expect(order).toEqual(["cleanup-two", "cleanup-one"]);
    expect(factories).toBe(0);
  });

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

  it("validates URL-encoded forms with strict encoding and repeated literal keys", async () => {
    const { router, handle } = createNitroLikeApp();
    const schema = z.object({
      name: z.string(),
      tag: z.array(z.string()),
      note: z.string().optional(),
      amount: z.string().transform(Number),
    });
    @Controller("/form")
    class FormController {
      @Post()
      async read(request: StrataAnalogRequest) {
        const value = await request.readValidatedForm(schema);
        expectTypeOf(value).toEqualTypeOf<{
          name: string;
          tag: string[];
          note?: string | undefined;
          amount: number;
        }>();
        return value;
      }

      @Post("/valibot")
      valibot(request: StrataAnalogRequest) {
        return request.readValidatedForm(
          v.pipe(
            v.object({ amount: v.string() }),
            v.transform(({ amount }) => Number(amount)),
          ),
        );
      }

      @Post("/async")
      async asynchronous(request: StrataAnalogRequest) {
        return request.readValidatedForm(
          z.object({ amount: z.string().transform(Number) }).refine(async ({ amount }) => {
            await Promise.resolve();
            return amount > 0;
          }),
        );
      }
    }
    registerControllers(router, [FormController]);
    const send = (
      body: string,
      contentType = "application/x-www-form-urlencoded; charset=UTF-8",
      path = "/form",
    ) =>
      handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        }),
      );

    const response = await send(
      "name=Alice+Smith&tag=one&tag=two&amount=3&note=&=empty&x%26y=a%3Db&user%5Brole%5D=reader&user.name=literal",
    );
    await expect(response.json()).resolves.toEqual({
      name: "Alice Smith",
      tag: ["one", "two"],
      amount: 3,
      note: "",
    });
    const valibot = await send("amount=4", "application/x-www-form-urlencoded", "/form/valibot");
    await expect(valibot.json()).resolves.toBe(4);
    const asynchronous = await send("amount=5", "application/x-www-form-urlencoded", "/form/async");
    await expect(asynchronous.json()).resolves.toEqual({ amount: 5 });

    for (const [body, contentType, status, error] of [
      ["name=%", "application/x-www-form-urlencoded", 400, "invalid_request"],
      ["name=%C3%28", "application/x-www-form-urlencoded", 400, "invalid_request"],
      [
        "name=ok",
        "application/x-www-form-urlencoded; charset=iso-8859-1",
        415,
        "unsupported_media_type",
      ],
      ["name=ok", "application/json", 415, "unsupported_media_type"],
    ] as const) {
      const rejected = await send(body, contentType);
      expect(rejected.status).toBe(status);
      expect(await rejected.text()).toBe(JSON.stringify({ error, source: "body" }));
      expect(rejected.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("keeps form keys literal, uses safe own properties, and follows form URL encoding", async () => {
    const { router, handle } = createNitroLikeApp();
    @Controller("/form-syntax")
    class FormSyntaxController {
      @Post()
      read(request: StrataAnalogRequest) {
        return request.readValidatedForm(z.unknown());
      }
    }
    registerControllers(router, [FormSyntaxController]);
    const response = await handle(
      new Request("http://localhost/form-syntax", {
        method: "POST",
        headers: { "content-type": 'APPLICATION/X-WWW-FORM-URLENCODED; charset="utf-8"' },
        body: "__proto__=own&constructor=ctor&prototype=proto&user%5Brole%5D=admin&user.name=dot&space=a+b&plus=a%2Bb&delim=a%26b%3Dc&empty=&=emptykey&utf8=%F0%9F%98%80&nul=%00&&",
      }),
    );
    const values = (await response.json()) as Record<string, unknown>;
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(values["__proto__"]).toBe("own");
    expect(values["constructor"]).toBe("ctor");
    expect(values["prototype"]).toBe("proto");
    expect(values["user[role]"]).toBe("admin");
    expect(values["user.name"]).toBe("dot");
    expect(values["space"]).toBe("a b");
    expect(values["plus"]).toBe("a+b");
    expect(values["delim"]).toBe("a&b=c");
    expect(values["empty"]).toBe("");
    expect(values[""]).toBe("emptykey");
    expect(values["utf8"]).toBe("😀");
    expect(values["nul"]).toBe("\0");

    const empty = await handle(
      new Request("http://localhost/form-syntax", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      }),
    );
    await expect(empty.json()).resolves.toEqual({});
  });

  it("bounds validated forms and prevents raw or incompatible readers from bypassing ownership", async () => {
    const { router, handle } = createNitroLikeApp();
    @Controller("/form-ownership")
    class FormOwnershipController {
      @Post()
      async read(request: StrataAnalogRequest) {
        const first = request.readValidatedForm(z.unknown());
        const second = request.readValidatedForm(z.unknown());
        const [left, right] = await Promise.all([first, second]);
        return { left, right, raw: await request.readText() };
      }
      @Post("/conflict")
      async conflict(request: StrataAnalogRequest) {
        await request.readValidatedForm(z.unknown());
        return request.readValidatedJson(z.unknown());
      }
      @Post("/raw-first")
      async rawFirst(request: StrataAnalogRequest) {
        await request.readBody();
        return request.readValidatedForm(z.unknown());
      }
      @Post("/json-first")
      async jsonFirst(request: StrataAnalogRequest) {
        await request.readValidatedJson(z.unknown());
        return request.readValidatedForm(z.unknown());
      }
    }
    registerControllers(router, [FormOwnershipController]);
    const send = (path: string, body: string) =>
      handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "0" },
          body,
        }),
      );
    const reused = await send("/form-ownership", "__proto__=safe&tag=one&tag=two");
    const value = (await reused.json()) as {
      left: Record<string, unknown>;
      right: unknown;
      raw: string;
    };
    expect(value.left["tag"]).toEqual(["one", "two"]);
    expect(Object.hasOwn(value.left, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(value.left)).toBe(Object.prototype);
    expect(value.right).toEqual(value.left);
    expect(value.raw).toBe("__proto__=safe&tag=one&tag=two");
    expect((await send("/form-ownership/conflict", "x=1")).status).toBe(500);
    expect((await send("/form-ownership/raw-first", "x=1")).status).toBe(500);
    const jsonFirst = await handle(
      new Request("http://localhost/form-ownership/json-first", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(jsonFirst.status).toBe(500);

    @Controller("/form-limit")
    class FormLimitController {
      @Post()
      read(request: StrataAnalogRequest) {
        return request.readValidatedForm(z.unknown());
      }
    }
    registerControllers(router, [FormLimitController]);
    const exact = await handle(
      new Request("http://localhost/form-limit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "x=" + "a".repeat(1024 * 1024 - 2),
      }),
    );
    expect(exact.status).toBe(200);
    const over = await handle(
      new Request("http://localhost/form-limit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "x=" + "a".repeat(1024 * 1024 - 1),
      }),
    );
    expect(over.status).toBe(413);
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
