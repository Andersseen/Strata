/* eslint-disable @typescript-eslint/require-await -- handlers and generators here yield or throw
   on cue; an await would only add a tick the tests do not want. */
import { Controller, Get, Post } from "@strata-sc/core";
import { createApp, createRouter, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";
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
import { streamResponse } from "./stream-lifecycle.js";

const CANARY = "synthetic-private-canary-9c1d";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function harness(controllers: readonly ControllerClass[], options: RegisterControllersOptions) {
  const observations: StrataAnalogRequestObservation[] = [];
  const waiting: Array<(o: StrataAnalogRequestObservation) => void> = [];
  const app = createApp();
  const router = createRouter({ preemptive: true });
  registerControllers(router, controllers, {
    ...options,
    onRequestSettled(observation) {
      observations.push(observation);
      waiting.shift()?.(observation);
    },
  });
  app.use(router.handler);
  const handle = toWebHandler(app);

  return {
    observations,
    next: () =>
      new Promise<StrataAnalogRequestObservation>((resolve) => {
        waiting.push(resolve);
      }),
    request: (path: string, init?: RequestInit) =>
      handle(new Request(`http://localhost${path}`, init)),
  };
}

const seen = new Map<string, string[]>();
function see(stage: string, request: StrataAnalogRequest) {
  seen.set(stage, [...(seen.get(stage) ?? []), request.correlationId ?? "<none>"]);
}
function resetSeen() {
  seen.clear();
}

@Controller("/c")
class Correlated {
  @Get("/ok")
  async ok(request: StrataAnalogRequest) {
    see("handler:before", request);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    see("handler:after", request);
    return { id: request.correlationId };
  }

  @Post("/validated")
  async validated(request: StrataAnalogRequest) {
    return request.readValidatedJson(z.object({ n: z.number() }));
  }

  @Get("/app-error")
  appError() {
    throw new StrataAnalogHttpError(409, "conflict");
  }

  @Get("/boom")
  boom() {
    throw new Error(`boom ${CANARY}`);
  }

  @Get("/stream")
  stream() {
    return streamResponse(
      (async function* () {
        yield "a";
        yield "b";
      })(),
    );
  }

  @Get("/stream-fail")
  streamFail() {
    return streamResponse(
      (async function* () {
        yield "a";
        throw new Error(CANARY);
      })(),
    );
  }

  @Get("/stream-hold")
  streamHold() {
    return streamResponse(
      (async function* () {
        yield "a";
        await new Promise(() => undefined);
      })(),
    );
  }
}

const tracing: RegisterControllersOptions = {
  requestCorrelation: true,
  guards: [
    ({ request }) => {
      see("guard", request);
      return request.url.searchParams.has("deny") ? { allow: false, status: 403 } : { allow: true };
    },
  ],
  interceptors: [
    async ({ request }, next) => {
      see("interceptor", request);
      return next();
    },
  ],
  controllerFactory(controller, { request }) {
    see("factory", request);
    return new controller();
  },
};

describe("requestCorrelation — registration", () => {
  it("is disabled by default: no id on the request or the observation", async () => {
    resetSeen();
    const h = harness([Correlated], { ...tracing, requestCorrelation: false });
    const response = await h.request("/c/ok");
    const [observation] = h.observations;

    expect(await response.json()).toEqual({});
    expect(seen.get("guard")).toEqual(["<none>"]);
    expect(observation).toBeDefined();
    expect("correlationId" in (observation as object)).toBe(false);
    expect(Object.keys(observation as object).sort()).toEqual([
      "cleanup",
      "elapsedMs",
      "invocationMs",
      "outcome",
      "phase",
      "route",
      "status",
      "streaming",
    ]);
  });

  it("does not generate identifiers when disabled", async () => {
    const spy = vi.spyOn(globalThis.crypto, "randomUUID");
    try {
      const h = harness([Correlated], {});
      await h.request("/c/ok");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a non-boolean option", () => {
    for (const value of ["yes", 1, {}, null]) {
      expect(() =>
        registerControllers(createRouter(), [Correlated], {
          requestCorrelation: value as unknown as boolean,
        }),
      ).toThrow(StrataAnalogConfigurationError);
    }
  });

  it("false behaves like the default", async () => {
    const h = harness([Correlated], { requestCorrelation: false });
    await h.request("/c/ok");
    expect("correlationId" in (h.observations[0] as object)).toBe(false);
  });
});

describe("requestCorrelation — lifecycle", () => {
  it("shows one stable id to guard, interceptor, factory, handler (before and after await) and observer", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const body = (await (await h.request("/c/ok")).json()) as { id: string };
    const observation = h.observations[0] as StrataAnalogRequestObservation;

    expect(body.id).toMatch(UUID);
    for (const stage of ["guard", "interceptor", "factory", "handler:before", "handler:after"]) {
      expect(seen.get(stage)).toEqual([body.id]);
    }
    expect(observation.correlationId).toBe(body.id);
    expect(observation.outcome).toBe("completed");
  });

  it("does not trust any client-supplied value", async () => {
    resetSeen();
    const supplied = "client-chosen-id";
    const h = harness([Correlated], tracing);
    await h.request(`/c/ok?correlationId=${supplied}&x-request-id=${supplied}`, {
      headers: {
        "x-request-id": supplied,
        "x-correlation-id": supplied,
        cookie: `correlationId=${supplied}`,
      },
    });

    expect(h.observations[0]?.correlationId).toMatch(UUID);
    expect(h.observations[0]?.correlationId).not.toContain(supplied);
  });

  it("generates unique ids across independent requests", async () => {
    const h = harness([Correlated], tracing);
    for (let i = 0; i < 10; i++) await h.request("/c/ok");
    const ids = h.observations.map((o) => o.correlationId);

    expect(new Set(ids).size).toBe(10);
  });

  it("keeps 24 overlapping requests isolated", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) => h.request(`/c/ok?user=user-${i}`)),
    );
    const ids = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { id: string }).id),
    );

    expect(new Set(ids).size).toBe(24);
    expect(h.observations).toHaveLength(24);
    for (const stage of ["guard", "interceptor", "factory", "handler:before", "handler:after"]) {
      expect([...(seen.get(stage) ?? [])].sort()).toEqual([...ids].sort());
    }
    expect(h.observations.map((o) => o.correlationId).sort()).toEqual([...ids].sort());
  });

  it("keeps ids isolated when requests interleave with failures", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        h.request(i % 3 === 0 ? "/c/boom" : i % 3 === 1 ? "/c/ok?deny=1" : "/c/app-error"),
      ),
    );

    expect(responses).toHaveLength(24);
    const ids = h.observations.map((o) => o.correlationId);
    expect(new Set(ids).size).toBe(24);
    expect(ids.every((id) => typeof id === "string" && UUID.test(id))).toBe(true);
  });
});

describe("requestCorrelation — outcomes", () => {
  it("guard denial: no controller, id still observed", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const response = await h.request("/c/ok?deny=1");
    const observation = h.observations[0];

    expect(response.status).toBe(403);
    expect(seen.get("factory")).toBeUndefined();
    expect(observation).toMatchObject({ outcome: "guard-denied", status: 403 });
    expect(observation?.correlationId).toBe(seen.get("guard")?.[0]);
  });

  it("input rejection keeps its status and the id; the body carries no id", async () => {
    const h = harness([Correlated], tracing);
    const response = await h.request("/c/validated", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: "bad", secret: CANARY }),
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(h.observations[0]).toMatchObject({ outcome: "input-rejected", status: 400 });
    expect(h.observations[0]?.correlationId).toMatch(UUID);
    expect(text).not.toContain(h.observations[0]?.correlationId);
    expect(JSON.stringify(h.observations[0])).not.toContain(CANARY);
  });

  it("application error keeps its safe response, without the id", async () => {
    const h = harness([Correlated], tracing);
    const response = await h.request("/c/app-error");
    const text = await response.text();

    expect(response.status).toBe(409);
    expect(h.observations[0]).toMatchObject({ outcome: "application-error", status: 409 });
    expect(text).not.toContain(h.observations[0]?.correlationId);
    expect(response.headers.get("x-request-id")).toBeNull();
    expect(response.headers.get("x-correlation-id")).toBeNull();
  });

  it("unexpected exception stays 'failed' and leaks nothing", async () => {
    const h = harness([Correlated], tracing);
    const response = await h.request("/c/boom");

    expect(response.status).toBe(500);
    expect(h.observations[0]).toMatchObject({ outcome: "failed", status: undefined });
    expect(h.observations[0]?.correlationId).toMatch(UUID);
    expect(JSON.stringify(h.observations[0])).not.toContain(CANARY);
    expect(await response.text()).not.toContain(h.observations[0]?.correlationId);
  });

  it("controller factory failure is 'failed' with the same id", async () => {
    resetSeen();
    const h = harness([Correlated], {
      ...tracing,
      controllerFactory(_controller, { request }) {
        see("factory", request);
        throw new Error(CANARY);
      },
    });
    const response = await h.request("/c/ok");

    expect(response.status).toBe(500);
    expect(h.observations[0]).toMatchObject({ outcome: "failed" });
    expect(h.observations[0]?.correlationId).toBe(seen.get("factory")?.[0]);
  });

  it("cleanup failure keeps precedence and the id", async () => {
    resetSeen();
    const h = harness([Correlated], {
      ...tracing,
      controllerFactory(controller, { request, onCleanup }) {
        see("factory", request);
        onCleanup(() => {
          throw new Error(CANARY);
        });
        return new controller();
      },
    });
    await h.request("/c/ok");

    expect(h.observations[0]).toMatchObject({ outcome: "cleanup-failed", cleanup: "failed" });
    expect(h.observations[0]?.correlationId).toBe(seen.get("factory")?.[0]);
    expect(JSON.stringify(h.observations[0])).not.toContain(CANARY);
  });

  it("handler and cleanup failing together report cleanup-failed with the id", async () => {
    resetSeen();
    const h = harness([Correlated], {
      ...tracing,
      controllerFactory(controller, { request, onCleanup }) {
        see("factory", request);
        onCleanup(() => {
          throw new Error("cleanup");
        });
        return new controller();
      },
    });
    const response = await h.request("/c/boom");

    expect(response.status).toBe(500);
    expect(h.observations[0]).toMatchObject({ outcome: "cleanup-failed" });
    expect(h.observations[0]?.correlationId).toBe(seen.get("factory")?.[0]);
  });
});

describe("requestCorrelation — streams", () => {
  it("keeps the id until completion and emits exactly once", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const response = await h.request("/c/stream");

    expect(h.observations).toEqual([]);
    expect(await response.text()).toBe("ab");
    expect(h.observations).toHaveLength(1);
    expect(h.observations[0]).toMatchObject({ outcome: "stream-completed" });
    expect(h.observations[0]?.correlationId).toBe(seen.get("guard")?.[0]);
  });

  it("keeps the id when the stream fails", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const response = await h.request("/c/stream-fail");
    await response.text().catch(() => undefined);
    const observation = h.observations[0] ?? (await h.next());

    expect(observation).toMatchObject({ outcome: "stream-failed" });
    expect(observation.correlationId).toBe(seen.get("guard")?.[0]);
    expect(JSON.stringify(observation)).not.toContain(CANARY);
  });

  it("keeps the id when the consumer cancels", async () => {
    resetSeen();
    const h = harness([Correlated], tracing);
    const settled = h.next();
    const response = await h.request("/c/stream-hold");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    const observation = await settled;

    expect(observation).toMatchObject({ outcome: "stream-cancelled" });
    expect(observation.correlationId).toBe(seen.get("guard")?.[0]);
    expect(h.observations).toHaveLength(1);
  });

  it("keeps the id when stream cleanup fails", async () => {
    resetSeen();
    const h = harness([Correlated], {
      ...tracing,
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          throw new Error("cleanup");
        });
        return new controller();
      },
    });
    const response = await h.request("/c/stream");
    await response.text().catch(() => undefined);
    const observation = h.observations[0] ?? (await h.next());

    expect(observation).toMatchObject({ outcome: "cleanup-failed", streaming: true });
    expect(observation.correlationId).toBe(seen.get("guard")?.[0]);
  });
});

describe("requestCorrelation — privacy", () => {
  it("never puts request data in the observation (with a positive detection control)", async () => {
    const h = harness([Correlated], tracing);
    await h.request(`/c/ok?q=${CANARY}`, {
      headers: { authorization: `Bearer ${CANARY}`, cookie: `s=${CANARY}` },
    });
    const serialized = JSON.stringify(h.observations[0]);

    expect(JSON.stringify({ leaked: CANARY })).toContain(CANARY); // control: detector works
    expect(serialized).not.toContain(CANARY);
    expect(h.observations[0]?.route.path).toBe("/c/ok");
  });
});

describe("requestCorrelation — observer isolation", () => {
  it("an observer that throws does not affect the response", async () => {
    const app = createApp();
    const router = createRouter({ preemptive: true });
    registerControllers(router, [Correlated], {
      requestCorrelation: true,
      onRequestSettled() {
        throw new Error(CANARY);
      },
    });
    app.use(router.handler);
    const response = await toWebHandler(app)(new Request("http://localhost/c/ok"));

    expect(response.status).toBe(200);
  });

  it("an observer returning a rejected promise does not affect the response", async () => {
    const app = createApp();
    const router = createRouter({ preemptive: true });
    registerControllers(router, [Correlated], {
      requestCorrelation: true,
      onRequestSettled() {
        return Promise.reject(new Error(CANARY)) as unknown as undefined;
      },
    });
    app.use(router.handler);
    const response = await toWebHandler(app)(new Request("http://localhost/c/ok"));

    expect(response.status).toBe(200);
  });

  it("works without an observer: the request still carries the id", async () => {
    resetSeen();
    const app = createApp();
    const router = createRouter({ preemptive: true });
    registerControllers(router, [Correlated], { requestCorrelation: true });
    app.use(router.handler);
    const body = (await (await toWebHandler(app)(new Request("http://localhost/c/ok"))).json()) as {
      id: string;
    };

    expect(body.id).toMatch(UUID);
  });
});
