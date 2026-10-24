/* eslint-disable @typescript-eslint/require-await -- async generators and handlers here yield or
   throw on cue; an await would only add a tick the tests do not want. */
import { Controller, Delete, Get, Patch, Post, Put } from "@strata-sc/core";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { StrataAnalogConfigurationError } from "./errors.js";
import { StrataAnalogHttpError } from "./http-error.js";
import { registerControllers } from "./register-controllers.js";
import type {
  ControllerClass,
  RegisterControllersOptions,
  StrataAnalogRequest,
} from "./register-controllers.js";
import type { StrataAnalogRequestObservation } from "./request-observation.js";
import { jsonResponse, noContent } from "./responses.js";
import { streamResponse } from "./stream-lifecycle.js";

const CANARY = "synthetic-private-canary-7f3a";

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A real h3 (Nitro's router engine) app, with every observation recorded. */
function harness(
  controllers: readonly ControllerClass[],
  options: RegisterControllersOptions = {},
) {
  const observations: StrataAnalogRequestObservation[] = [];
  const waiting: Array<(observation: StrataAnalogRequestObservation) => void> = [];
  const events: string[] = [];
  const app = createApp();
  const router = createRouter({ preemptive: true });

  router.add(
    "/native",
    defineEventHandler(() => ({ native: true })),
  );
  registerControllers(router, controllers, {
    ...options,
    onRequestSettled(observation) {
      events.push(`observed:${observation.outcome}`);
      observations.push(observation);
      waiting.shift()?.(observation);
    },
  });
  app.use(router.handler);
  const handle = toWebHandler(app);

  return {
    observations,
    events,
    /** Resolves with the next observation, a barrier instead of a sleep. */
    next: () =>
      new Promise<StrataAnalogRequestObservation>((resolve) => {
        waiting.push(resolve);
      }),
    request: (path: string, init?: RequestInit) =>
      handle(new Request(`http://localhost${path}`, init)),
  };
}

function only(observations: readonly StrataAnalogRequestObservation[]) {
  expect(observations).toHaveLength(1);
  return observations[0] as StrataAnalogRequestObservation;
}

describe("onRequestSettled — synchronous invocations", () => {
  @Controller("/o")
  class Plain {
    @Get("/data")
    data() {
      return { ok: true };
    }
    @Get("/native-response")
    nativeResponse() {
      return new Response("hi", { status: 202 });
    }
    @Get("/json")
    json() {
      return jsonResponse({ ok: true }, { status: 201 });
    }
    @Delete("/none")
    none() {
      return noContent();
    }
    @Put("/put")
    put() {
      return "put";
    }
    @Patch("/patch")
    patch() {
      return "patch";
    }
    @Post("/post")
    post() {
      return "post";
    }
  }

  it("reports a completed invocation once per method, with the registered route", async () => {
    const h = harness([Plain]);
    const cases = [
      ["GET", "/o/data", 200, "GET"],
      ["GET", "/o/native-response", 202, "GET"],
      ["GET", "/o/json", 201, "GET"],
      ["DELETE", "/o/none", 204, "DELETE"],
      ["PUT", "/o/put", 200, "PUT"],
      ["PATCH", "/o/patch", 200, "PATCH"],
      ["POST", "/o/post", 200, "POST"],
    ] as const;

    for (const [method, path, status, routeMethod] of cases) {
      h.observations.length = 0;
      const response = await h.request(path, { method });
      expect(response.status).toBe(status);
      await response.text();

      const observation = only(h.observations);
      expect(observation).toMatchObject({
        outcome: "completed",
        status: undefined,
        phase: "execution",
        streaming: false,
        cleanup: "completed",
        route: { method: routeMethod, path, controller: "Plain" },
      });
      expect(observation.invocationMs).toBeGreaterThanOrEqual(0);
      expect(observation.elapsedMs).toBeGreaterThanOrEqual(observation.invocationMs);
      expect(Object.isFrozen(observation)).toBe(true);
    }
  });

  it("does not observe native routes or the app's own misses", async () => {
    const h = harness([Plain]);
    expect(await (await h.request("/native")).json()).toEqual({ native: true });
    expect((await h.request("/missing")).status).toBe(404);
    expect(h.observations).toEqual([]);
  });

  it("is off by default and rejects a non-function observer", () => {
    expect(() =>
      registerControllers({ add: () => undefined }, [Plain], {
        onRequestSettled: "log" as unknown as () => void,
      }),
    ).toThrow(StrataAnalogConfigurationError);
    expect(() => registerControllers({ add: () => undefined }, [Plain])).not.toThrow();
  });
});

describe("onRequestSettled — guards, validation and errors", () => {
  const constructed: string[] = [];

  @Controller("/e")
  class Failing {
    constructor() {
      constructed.push("constructed");
    }
    @Get("/app")
    app() {
      throw new StrataAnalogHttpError(404, "missing", `private ${CANARY}`, {
        cause: new Error(CANARY),
      });
    }
    @Get("/boom")
    boom() {
      throw new Error(`private ${CANARY}`);
    }
    @Post("/body")
    async body(request: StrataAnalogRequest) {
      return request.readValidatedJson(z.object({ n: z.number() }));
    }
    @Get("/q")
    async query(request: StrataAnalogRequest) {
      return request.validateQuery(z.object({ n: z.coerce.number().max(5) }));
    }
  }

  it.each([401, 403] as const)(
    "classifies a guard denial %i without constructing the controller",
    async (status) => {
      constructed.length = 0;
      const h = harness([Failing], { guards: [() => ({ allow: false, status })] });
      const response = await h.request("/e/app");

      expect(response.status).toBe(status);
      expect(constructed).toEqual([]);
      expect(only(h.observations)).toMatchObject({
        outcome: "guard-denied",
        status,
        phase: "guards",
        cleanup: "completed",
      });
    },
  );

  it("classifies rejected input with its status and no issue details", async () => {
    const h = harness([Failing]);
    const post = (body: string, type: string) =>
      h.request(`/e/body?secret=${CANARY}`, {
        method: "POST",
        headers: { "content-type": type, authorization: `Bearer ${CANARY}`, cookie: CANARY },
        body,
      });
    const cases = [
      [JSON.stringify({ n: CANARY }), "application/json", 400],
      ["{", "application/json", 400],
      ["{}", "text/plain", 415],
      [JSON.stringify({ data: "x".repeat(1024 * 1024) }), "application/json", 413],
    ] as const;

    for (const [body, type, status] of cases) {
      h.observations.length = 0;
      expect((await post(body, type)).status).toBe(status);
      expect(only(h.observations)).toMatchObject({ outcome: "input-rejected", status });
    }

    h.observations.length = 0;
    expect((await h.request(`/e/q?n=${CANARY}`)).status).toBe(400);
    expect(only(h.observations)).toMatchObject({ outcome: "input-rejected", status: 400 });
  });

  it("classifies an expected application error without its message or cause", async () => {
    const h = harness([Failing]);
    const response = await h.request("/e/app");

    expect(response.status).toBe(404);
    const observation = only(h.observations);
    expect(observation).toMatchObject({ outcome: "application-error", status: 404 });
    expect(JSON.stringify(observation)).not.toContain(CANARY);
  });

  it("classifies an unexpected failure with an unknown status, and the failure still propagates", async () => {
    const h = harness([Failing]);
    const response = await h.request("/e/boom");

    expect(response.status).toBe(500);
    expect(only(h.observations)).toMatchObject({
      outcome: "failed",
      status: undefined,
      phase: "execution",
      cleanup: "completed",
    });
  });

  it("classifies factory rejection, a missing next() and a bad guard decision as failed", async () => {
    const factory = harness([Failing], {
      controllerFactory: () => Promise.reject(new Error(CANARY)),
    });
    expect((await factory.request("/e/boom")).status).toBe(500);
    expect(only(factory.observations)).toMatchObject({ outcome: "failed", phase: "execution" });

    const interceptor = harness([Failing], { interceptors: [() => "no next()"] });
    expect((await interceptor.request("/e/boom")).status).toBe(500);
    expect(only(interceptor.observations)).toMatchObject({ outcome: "failed" });

    const guard = harness([Failing], {
      guards: [(() => ({ allow: "yes" })) as unknown as () => { allow: true }],
    });
    expect((await guard.request("/e/boom")).status).toBe(500);
    expect(only(guard.observations)).toMatchObject({ outcome: "failed", phase: "guards" });
  });

  it("observes through interceptors that wrap or replace the result", async () => {
    const order: string[] = [];
    const h = harness([Failing], {
      interceptors: [
        async (_context, next) => {
          order.push("outer:in");
          const value = await next();
          order.push("outer:out");
          return value;
        },
        async (_context, next) => {
          order.push("inner:in");
          await next().catch(() => undefined);
          order.push("inner:out");
          return { replaced: true };
        },
      ],
    });
    const response = await h.request("/e/boom");

    expect(await response.json()).toEqual({ replaced: true });
    expect(order).toEqual(["outer:in", "inner:in", "inner:out", "outer:out"]);
    expect(only(h.observations)).toMatchObject({ outcome: "completed" });
  });
});

describe("onRequestSettled — cleanup sequencing", () => {
  @Controller("/c")
  class Cleaning {
    @Get("/ok")
    ok() {
      return "ok";
    }
    @Get("/fail")
    fail() {
      throw new Error(CANARY);
    }
  }

  it("emits after every cleanup ran, last registered first", async () => {
    const h = harness([Cleaning], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          h.events.push("cleanup:first");
        });
        onCleanup(() => {
          h.events.push("cleanup:second");
        });
        return new controller();
      },
    });
    const response = await h.request("/c/ok");

    expect(await response.text()).toBe("ok");
    expect(h.events).toEqual(["cleanup:second", "cleanup:first", "observed:completed"]);
    expect(only(h.observations).cleanup).toBe("completed");
  });

  it("reports a single cleanup failure as cleanup-failed, not as success", async () => {
    const h = harness([Cleaning], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          throw new Error(CANARY);
        });
        return new controller();
      },
    });

    expect((await h.request("/c/ok")).status).toBe(500);
    expect(only(h.observations)).toMatchObject({
      outcome: "cleanup-failed",
      phase: "cleanup",
      cleanup: "failed",
      status: undefined,
    });
  });

  it("reports several cleanup failures, and a handler plus cleanup failure, once", async () => {
    const make = () =>
      harness([Cleaning], {
        controllerFactory(controller, { onCleanup }) {
          onCleanup(() => {
            throw new Error(`a ${CANARY}`);
          });
          onCleanup(() => {
            throw new Error(`b ${CANARY}`);
          });
          return new controller();
        },
      });

    for (const path of ["/c/ok", "/c/fail"]) {
      const h = make();
      expect((await h.request(path)).status).toBe(500);
      const observation = only(h.observations);
      expect(observation).toMatchObject({ outcome: "cleanup-failed", cleanup: "failed" });
      expect(JSON.stringify(observation)).not.toContain(CANARY);
    }
  });
});

describe("onRequestSettled — streamed responses", () => {
  const states = {
    cleanups: [] as string[],
    release: gate(),
    cancelled: gate(),
  };

  function reset() {
    states.cleanups = [];
    states.release = gate();
    states.cancelled = gate();
  }

  @Controller("/s")
  class Streaming {
    @Get("/ok")
    ok() {
      return streamResponse(
        (async function* () {
          yield "a";
          yield "b";
        })(),
        { status: 207 },
      );
    }
    @Get("/partial")
    partial() {
      return streamResponse(
        (async function* () {
          yield `chunk ${CANARY}`;
          throw new Error(`stream ${CANARY}`);
        })(),
      );
    }
    @Get("/held")
    held() {
      return streamResponse(
        (async function* () {
          try {
            yield "first";
            await states.release.promise;
            yield "never";
          } finally {
            states.cancelled.open();
          }
        })(),
      );
    }
    @Get("/replaced")
    replaced() {
      return streamResponse((async function* () {})());
    }
  }

  const cleaning: RegisterControllersOptions = {
    controllerFactory(controller, { onCleanup }) {
      onCleanup(() => {
        states.cleanups.push("cleanup");
      });
      return new controller();
    },
  };

  it("does not report at handler return; reports completion after the body and cleanup", async () => {
    reset();
    const h = harness([Streaming], cleaning);
    const response = await h.request("/s/ok");

    expect(response.status).toBe(207);
    expect(h.observations).toEqual([]);
    expect(await response.text()).toBe("ab");
    expect(only(h.observations)).toMatchObject({
      outcome: "stream-completed",
      phase: "stream",
      streaming: true,
      cleanup: "completed",
      status: undefined,
    });
    expect(h.events).toEqual(["observed:stream-completed"]);
    expect(states.cleanups).toEqual(["cleanup"]);
  });

  it("separates invocation time from the stream's observed lifetime", async () => {
    reset();
    const h = harness([Streaming], cleaning);
    await (await h.request("/s/ok")).text();
    const observation = only(h.observations);

    expect(observation.elapsedMs).toBeGreaterThanOrEqual(observation.invocationMs);
  });

  it("reports a stream that fails after partial output, without its message", async () => {
    reset();
    const h = harness([Streaming], cleaning);
    const response = await h.request("/s/partial");
    await response.text().catch(() => undefined);
    const observation = await (h.observations[0] ? Promise.resolve(h.observations[0]) : h.next());

    expect(observation).toMatchObject({ outcome: "stream-failed", streaming: true });
    expect(h.observations).toHaveLength(1);
    expect(JSON.stringify(observation)).not.toContain(CANARY);
    expect(states.cleanups).toEqual(["cleanup"]);
  });

  it("reports an observable cancellation once, after cleanup", async () => {
    reset();
    const h = harness([Streaming], cleaning);
    const settled = h.next();
    const response = await h.request("/s/held");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    expect((await reader.read()).done).toBe(false);
    expect(h.observations).toEqual([]);
    await reader.cancel();

    expect(await settled).toMatchObject({ outcome: "stream-cancelled", streaming: true });
    await states.cancelled.promise;
    expect(states.cleanups).toEqual(["cleanup"]);
    expect(h.observations).toHaveLength(1);
  });

  it("reports a cleanup failure of an owned stream as cleanup-failed", async () => {
    reset();
    const h = harness([Streaming], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          throw new Error(CANARY);
        });
        return new controller();
      },
    });
    const response = await h.request("/s/ok");
    await response.text().catch(() => undefined);

    expect(h.observations).toHaveLength(1);
    expect(only(h.observations)).toMatchObject({
      outcome: "cleanup-failed",
      streaming: true,
      cleanup: "failed",
    });
  });

  it("does not report a fake stream completion when an interceptor replaces the stream", async () => {
    reset();
    const h = harness([Streaming], {
      ...cleaning,
      interceptors: [
        async (_context, next) => {
          await next();
          return { replaced: true };
        },
      ],
    });
    const response = await h.request("/s/replaced");

    expect(await response.json()).toEqual({ replaced: true });
    expect(only(h.observations)).toMatchObject({ outcome: "completed", streaming: false });
    expect(states.cleanups).toEqual(["cleanup"]);
  });

  it("reports a never-consumed stream never: there is no timeout to fake it", async () => {
    reset();
    const h = harness([Streaming], cleaning);
    // Handler returns, the transport never reads or cancels the body.
    const { request } = h;
    const response = await request("/s/held", { method: "GET" });

    expect(response.status).toBe(200);
    expect(h.observations).toEqual([]);
    await (response.body as ReadableStream<Uint8Array>).cancel();
    expect(h.observations).toHaveLength(1);
  });

  it("derived HEAD over a stream reports a cancellation after cleanup, never a completion", async () => {
    reset();
    const h = harness([Streaming], {
      ...cleaning,
      apiBoundary: { prefixes: ["/s"] },
    });
    const settled = h.next();
    const response = await h.request("/s/ok", { method: "HEAD" });

    expect(await response.text()).toBe("");
    expect(await settled).toMatchObject({ outcome: "stream-cancelled", cleanup: "completed" });
    expect(states.cleanups).toEqual(["cleanup"]);
    expect(h.observations).toHaveLength(1);
  });
});

describe("onRequestSettled — observer isolation", () => {
  @Controller("/i")
  class Isolated {
    @Get("/ok")
    ok() {
      return { ok: true };
    }
    @Get("/app")
    app() {
      throw new StrataAnalogHttpError(409, "conflict");
    }
    @Get("/boom")
    boom() {
      throw new Error("handler failure");
    }
    @Get("/stream")
    stream() {
      return streamResponse(
        (async function* () {
          yield "x";
        })(),
      );
    }
  }

  function throwing(controllers: readonly ControllerClass[], options: RegisterControllersOptions) {
    const calls: string[] = [];
    const app = createApp();
    const router = createRouter({ preemptive: true });
    registerControllers(router, controllers, {
      ...options,
      onRequestSettled(observation) {
        calls.push(observation.outcome);
        throw new Error("observer failed");
      },
    });
    app.use(router.handler);
    const handle = toWebHandler(app);
    return { calls, request: (path: string) => handle(new Request(`http://localhost${path}`)) };
  }

  it("keeps the response, the expected error, the handler failure and the stream unchanged", async () => {
    let cleanups = 0;
    const h = throwing([Isolated], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          cleanups += 1;
        });
        return new controller();
      },
    });

    expect(await (await h.request("/i/ok")).json()).toEqual({ ok: true });
    expect((await h.request("/i/app")).status).toBe(409);
    expect((await h.request("/i/boom")).status).toBe(500);
    expect(await (await h.request("/i/stream")).text()).toBe("x");
    expect(h.calls).toEqual(["completed", "application-error", "failed", "stream-completed"]);
    expect(cleanups).toBe(4);
  });

  it("keeps a cleanup AggregateError ahead of an observer failure", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const router = createRouter({ preemptive: true });
    registerControllers(router, [Isolated], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          throw new Error("c1");
        });
        onCleanup(() => {
          throw new Error("c2");
        });
        return new controller();
      },
      onRequestSettled(observation) {
        calls.push(observation.outcome);
        throw new Error("observer failed");
      },
    });
    const app = createApp({ onError: (error) => void errors.push(error) });
    app.use(router.handler);
    const response = await toWebHandler(app)(new Request("http://localhost/i/ok"));

    expect(response.status).toBe(500);
    expect(calls).toEqual(["cleanup-failed"]);
    const cause = (errors[0] as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toHaveLength(2);
  });

  it("neither awaits an async observer nor lets its rejection escape", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const slow = gate();
    const router = createRouter({ preemptive: true });
    registerControllers(router, [Isolated], {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the unsupported misuse under test
      onRequestSettled: async () => {
        await slow.promise;
        throw new Error("async observer failed");
      },
    });
    const app = createApp();
    app.use(router.handler);
    const response = await toWebHandler(app)(new Request("http://localhost/i/ok"));

    // The response is complete while the observer's promise is still pending.
    expect(await response.json()).toEqual({ ok: true });
    slow.open();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe("onRequestSettled — isolation between requests and confidentiality", () => {
  @Controller("/t/:tenant")
  class Tenants {
    @Get("/work")
    async work(request: StrataAnalogRequest) {
      await gates.get(request.params["tenant"] ?? "")?.promise;
      return { tenant: request.params["tenant"] };
    }
  }
  const gates = new Map<string, Gate>();

  it("keeps overlapping requests apart, one observation each, with the route template", async () => {
    gates.set("alpha", gate());
    gates.set("beta", gate());
    const h = harness([Tenants]);
    const alpha = h.request(`/t/alpha/work?token=${CANARY}`, {
      headers: { authorization: `Bearer ${CANARY}`, cookie: `s=${CANARY}` },
    });
    const beta = h.request("/t/beta/work");

    gates.get("beta")?.open();
    await beta;
    expect(h.observations).toHaveLength(1);
    gates.get("alpha")?.open();
    await alpha;

    expect(h.observations).toHaveLength(2);
    for (const observation of h.observations) {
      expect(observation.route.path).toBe("/t/:tenant/work");
      expect(observation).toMatchObject({ outcome: "completed" });
      const serialized = JSON.stringify(observation);
      for (const secret of [CANARY, "alpha", "beta", "token", "authorization", "cookie"]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it("carries only the documented fields", async () => {
    gates.clear();
    const h = harness([Tenants]);
    await h.request("/t/gamma/work");

    expect(Object.keys(only(h.observations)).sort()).toEqual(
      [
        "cleanup",
        "elapsedMs",
        "invocationMs",
        "outcome",
        "phase",
        "route",
        "status",
        "streaming",
      ].sort(),
    );
    expect(Object.keys(only(h.observations).route).sort()).toEqual(
      ["controller", "handler", "method", "path"].sort(),
    );
  });
});
