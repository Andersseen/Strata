/* eslint-disable @typescript-eslint/require-await -- the async generators here are bodies that
   yield or throw on cue; an await would only add a tick the tests do not want. */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Controller, Get, Post } from "@strata-sc/core";
import { describe, expect, it } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type {
  ControllerClass,
  RegisterControllersOptions,
  StrataAnalogRequest,
} from "./register-controllers.js";
import { jsonResponse } from "./responses.js";
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

/** Resolves once `count` chunks have been produced: a barrier, not a sleep. */
function counter(): { reached: (count: number) => Promise<void>; tick: () => void } {
  let produced = 0;
  const waiters: Array<{ count: number; open: () => void }> = [];
  return {
    tick() {
      produced += 1;
      for (const waiter of waiters) if (produced >= waiter.count) waiter.open();
    },
    reached(count) {
      if (produced >= count) return Promise.resolve();
      const g = gate();
      waiters.push({ count, open: g.open });
      return g.promise;
    },
  };
}

function routeHandler(
  controller: ControllerClass,
  options: RegisterControllersOptions,
  path = "/stream",
): (event?: object) => Promise<unknown> {
  const handlers: Array<(event: object) => unknown> = [];
  registerControllers({ add: (_path, handler) => handlers.push(handler) }, [controller], options);
  const handler = handlers[0];
  if (!handler) throw new Error("Expected a route handler.");
  return (event = {}) => Promise.resolve(handler({ path, ...event }));
}

const decoder = new TextDecoder();

function bodyReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  return (response.body as ReadableStream<Uint8Array>).getReader();
}

async function readAll(response: Response): Promise<string> {
  return response.text();
}

/** Builds a controller whose handler returns `produce(resource)`; logs cleanup order. */
function setup(
  produce: (log: string[], request: StrataAnalogRequest) => Response | Promise<Response>,
  options: {
    readonly cleanups?: readonly string[];
    readonly failing?: ReadonlyMap<string, unknown>;
    readonly async?: boolean;
  } = {},
) {
  const log: string[] = [];
  const cleanups = options.cleanups ?? ["resource"];

  @Controller("/stream")
  class StreamController {
    @Get()
    handle(request: StrataAnalogRequest) {
      return produce(log, request);
    }
  }

  const handler = routeHandler(StreamController, {
    controllerFactory: (Class, { onCleanup }) => {
      for (const name of cleanups) {
        onCleanup(async () => {
          if (options.async) await Promise.resolve();
          log.push(`cleanup:${name}`);
          if (options.failing?.has(name)) throw options.failing.get(name);
        });
      }
      return new Class();
    },
  });

  return { log, handler };
}

async function* chunks(log: string[], ...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) {
    log.push(`produce:${part}`);
    yield part;
  }
}

describe("streamResponse() lifetime", () => {
  it("keeps resources open between chunks that a barrier separates, then closes once", async () => {
    const release = gate();
    const first = counter();
    const { log, handler } = setup((entries) =>
      streamResponse(
        (async function* () {
          entries.push("produce:a");
          first.tick();
          yield "a";
          await release.promise;
          entries.push("produce:b");
          yield "b";
        })(),
      ),
    );

    const response = (await handler()) as Response;
    // The handler settled; the resource is still open.
    expect(log).toEqual([]);

    const reader = bodyReader(response);
    expect(decoder.decode((await reader.read()).value)).toBe("a");
    await first.reached(1);
    expect(log).toEqual(["produce:a"]);

    const second = reader.read();
    release.open();
    expect(decoder.decode((await second).value)).toBe("b");
    expect(log).toEqual(["produce:a", "produce:b"]);

    expect((await reader.read()).done).toBe(true);
    expect(log).toEqual(["produce:a", "produce:b", "cleanup:resource"]);
    await reader.cancel();
    expect(log.filter((entry) => entry.startsWith("cleanup"))).toHaveLength(1);
  });

  it("never reads ahead of the consumer", async () => {
    const { log, handler } = setup((entries) => streamResponse(chunks(entries, "a", "b", "c")));
    const response = (await handler()) as Response;
    await Promise.resolve();
    expect(log).toEqual([]);
    const reader = bodyReader(response);
    await reader.read();
    expect(log).toEqual(["produce:a"]);
    await reader.cancel();
  });

  it("runs several cleanups in reverse order, awaiting asynchronous ones", async () => {
    const { log, handler } = setup((entries) => streamResponse(chunks(entries, "x")), {
      cleanups: ["first", "second", "third"],
      async: true,
    });
    expect(await readAll((await handler()) as Response)).toBe("x");
    expect(log).toEqual(["produce:x", "cleanup:third", "cleanup:second", "cleanup:first"]);
  });

  it("encodes strings and passes bytes through", async () => {
    const { handler } = setup(() =>
      streamResponse(
        (async function* () {
          yield "é";
          yield new Uint8Array([0x21]);
        })(),
        { status: 201, headers: { "x-test": "1" } },
      ),
    );
    const response = (await handler()) as Response;
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await readAll(response)).toBe("é!");
  });

  it("errors the stream after its first chunk, closes once and keeps the producer error", async () => {
    const failure = new Error(CANARY);
    const { log, handler } = setup(() =>
      streamResponse(
        (async function* () {
          yield "first";
          throw failure;
        })(),
      ),
    );
    const reader = bodyReader((await handler()) as Response);
    expect(decoder.decode((await reader.read()).value)).toBe("first");
    await expect(reader.read()).rejects.toBe(failure);
    expect(log).toEqual(["cleanup:resource"]);
  });

  it("closes once when the producer fails before any chunk", async () => {
    const failure = new Error("producer failed");
    const { log, handler } = setup(() =>
      streamResponse(
        // eslint-disable-next-line require-yield
        (async function* () {
          throw failure;
        })(),
      ),
    );
    const response = (await handler()) as Response;
    await expect(response.text()).rejects.toBe(failure);
    expect(log).toEqual(["cleanup:resource"]);
  });

  it("closes once when the consumer cancels, after stopping the producer", async () => {
    const { log, handler } = setup((entries) =>
      streamResponse(
        (async function* () {
          try {
            yield "a";
            yield "b";
          } finally {
            entries.push("producer:finally");
          }
        })(),
      ),
    );
    const reader = bodyReader((await handler()) as Response);
    await reader.read();
    await reader.cancel();
    await reader.cancel();
    expect(log).toEqual(["producer:finally", "cleanup:resource"]);
  });

  it("closes exactly once when cancellation races completion", async () => {
    const last = gate();
    const { log, handler } = setup(
      () =>
        streamResponse(
          (async function* () {
            yield "a";
            await last.promise;
          })(),
        ),
      { async: true },
    );
    const reader = bodyReader((await handler()) as Response);
    await reader.read();
    const pending = reader.read();
    const cancelled = reader.cancel();
    last.open();
    await Promise.allSettled([pending, cancelled]);
    await reader.cancel();
    expect(log).toEqual(["cleanup:resource"]);
  });

  it("surfaces the cleanup failure instead of a successful completion", async () => {
    const cleanupError = new Error("cleanup failed");
    const { handler } = setup(() => streamResponse(chunks([], "a")), {
      failing: new Map([["resource", cleanupError]]),
    });
    const response = (await handler()) as Response;
    await expect(response.text()).rejects.toBe(cleanupError);
  });

  it("reports a stream error and a cleanup error together, producer first", async () => {
    const streamError = new Error("stream failed");
    const cleanupError = new Error("cleanup failed");
    const { log, handler } = setup(
      () =>
        streamResponse(
          // eslint-disable-next-line require-yield
          (async function* () {
            throw streamError;
          })(),
        ),
      { failing: new Map([["resource", cleanupError]]) },
    );
    const response = (await handler()) as Response;
    const error = (await response.text().catch((reason: unknown) => reason)) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([streamError, cleanupError]);
    expect(log).toEqual(["cleanup:resource"]);
  });

  it("attempts every cleanup when several fail", async () => {
    const one = new Error("one");
    const two = new Error("two");
    const { log, handler } = setup(() => streamResponse(chunks([], "a")), {
      cleanups: ["first", "second", "third"],
      failing: new Map<string, unknown>([
        ["third", one],
        ["first", two],
      ]),
    });
    const response = (await handler()) as Response;
    const error = (await response.text().catch((reason: unknown) => reason)) as AggregateError;
    expect(error.errors).toEqual([one, two]);
    expect(log).toEqual(["cleanup:third", "cleanup:second", "cleanup:first"]);
  });

  it("rejects an unsupported chunk type as a stream failure, stopping the producer and releasing once", async () => {
    const { log, handler } = setup((entries) =>
      streamResponse(
        (async function* () {
          try {
            yield 42 as unknown as string;
          } finally {
            entries.push("producer:finally");
          }
        })(),
      ),
    );
    const response = (await handler()) as Response;
    await expect(response.text()).rejects.toThrow("strings or Uint8Array");
    expect(log).toEqual(["producer:finally", "cleanup:resource"]);
  });

  it("rejects a body that is not async iterable at construction", () => {
    expect(() => streamResponse([] as unknown as AsyncIterable<string>)).toThrow(
      StrataAnalogConfigurationError,
    );
  });
});

describe("streamResponse() with interceptors, guards and validation", () => {
  function controllerWith(produce: () => Response) {
    @Controller("/stream")
    class StreamController {
      @Get()
      handle() {
        return produce();
      }
      @Post()
      create() {
        return produce();
      }
    }
    return StreamController;
  }

  function track(log: string[]): Pick<RegisterControllersOptions, "controllerFactory"> {
    return {
      controllerFactory: (Class, { onCleanup }) => {
        log.push("construct");
        onCleanup(() => {
          log.push("cleanup");
        });
        return new Class();
      },
    };
  }

  it("preserves the lifetime through a pass-through interceptor that reads only headers", async () => {
    const log: string[] = [];
    const handler = routeHandler(
      controllerWith(() => streamResponse(chunks(log, "a", "b"))),
      {
        ...track(log),
        interceptors: [
          async (_context, next) => {
            log.push("enter");
            const result = (await next()) as Response;
            void result.headers.get("content-type");
            void result.status;
            log.push("exit");
            return result;
          },
        ],
      },
    );
    const response = (await handler()) as Response;
    expect(log).toEqual(["enter", "construct", "exit"]);
    expect(await readAll(response)).toBe("ab");
    expect(log).toEqual(["enter", "construct", "exit", "produce:a", "produce:b", "cleanup"]);
  });

  it("closes eagerly when an interceptor replaces the response, and the orphan cannot be read", async () => {
    const log: string[] = [];
    let orphan: Response | undefined;
    const handler = routeHandler(
      controllerWith(() => streamResponse(chunks(log, "a"))),
      {
        ...track(log),
        interceptors: [
          async (_context, next) => {
            orphan = (await next()) as Response;
            return jsonResponse({ replaced: true });
          },
        ],
      },
    );
    const response = (await handler()) as Response;
    expect(await response.json()).toEqual({ replaced: true });
    expect(log).toEqual(["construct", "cleanup"]);

    await expect(orphan!.text()).rejects.toBeInstanceOf(StrataAnalogConfigurationError);
    expect(log).toEqual(["construct", "cleanup"]);
  });

  it("closes eagerly when a pass-through interceptor rebuilds the response", async () => {
    const log: string[] = [];
    const handler = routeHandler(
      controllerWith(() => streamResponse(chunks(log, "a"))),
      {
        ...track(log),
        interceptors: [
          async (_context, next) => {
            const original = (await next()) as Response;
            return new Response(original.body, original);
          },
        ],
      },
    );
    const response = (await handler()) as Response;
    expect(log).toEqual(["construct", "cleanup"]);
    await expect(response.text()).rejects.toBeInstanceOf(StrataAnalogConfigurationError);
    expect(log).toEqual(["construct", "cleanup"]);
  });

  it("fails the invocation when an interceptor reads the body before the adapter owns it", async () => {
    const log: string[] = [];
    const handler = routeHandler(
      controllerWith(() => streamResponse(chunks(log, "a"))),
      {
        ...track(log),
        interceptors: [
          async (_context, next) => {
            const result = (await next()) as Response;
            await result.text();
            return result;
          },
        ],
      },
    );
    await expect(handler()).rejects.toBeInstanceOf(StrataAnalogConfigurationError);
    expect(log).toEqual(["construct", "cleanup"]);
  });

  it("closes eagerly when the same streamed response is returned twice", async () => {
    const log: string[] = [];
    const shared = streamResponse(chunks(log, "a"));
    const handler = routeHandler(
      controllerWith(() => shared),
      track(log),
    );
    await handler();
    await expect(handler()).rejects.toBeInstanceOf(StrataAnalogConfigurationError);
    expect(log).toEqual(["construct", "construct", "cleanup"]);
    await shared.body!.cancel();
    expect(log).toEqual(["construct", "construct", "cleanup", "cleanup"]);
  });

  it("closes eagerly when the consumer cancelled before the adapter claimed it", async () => {
    const log: string[] = [];
    const handler = routeHandler(
      controllerWith(() => streamResponse(chunks(log, "a"))),
      {
        ...track(log),
        interceptors: [
          async (_context, next) => {
            const result = (await next()) as Response;
            await result.body!.cancel();
            return result;
          },
        ],
      },
    );
    await handler();
    expect(log).toEqual(["construct", "cleanup"]);
  });

  it("never constructs the controller or starts the stream when a guard denies", async () => {
    const log: string[] = [];
    const handler = routeHandler(
      controllerWith(() => streamResponse(chunks(log, "a"))),
      {
        ...track(log),
        guards: [() => ({ allow: false, status: 403 })],
      },
    );
    const response = (await handler()) as Response;
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("a");
    expect(log).toEqual([]);
  });

  it("answers invalid input with a non-streamed response and closes eagerly", async () => {
    const log: string[] = [];
    const schema: StandardSchemaV1<unknown, { name: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "object" && value !== null && "name" in value
            ? { value: value as { name: string } }
            : { issues: [{ message: CANARY }] },
      },
    };

    @Controller("/stream")
    class ValidatedController {
      @Post()
      async create(request: StrataAnalogRequest) {
        await request.readValidatedJson(schema);
        return streamResponse(chunks(log, "a"));
      }
    }

    const handler = routeHandler(ValidatedController, track(log));
    const response = (await handler({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })) as Response;
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await response.text()).not.toContain(CANARY);
    expect(log).toEqual(["construct", "cleanup"]);
  });

  it("closes once and keeps the failure when the handler throws before returning a stream", async () => {
    const log: string[] = [];
    const failure = new Error("handler failed");
    const handler = routeHandler(
      controllerWith(() => {
        throw failure;
      }),
      track(log),
    );
    await expect(handler()).rejects.toBe(failure);
    expect(log).toEqual(["construct", "cleanup"]);
  });
});

describe("existing cleanup contract", () => {
  it("still closes before a plain JSON handler settles", async () => {
    const log: string[] = [];

    @Controller("/stream")
    class PlainController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    const handler = routeHandler(PlainController, {
      controllerFactory: (Class, { onCleanup }) => {
        onCleanup(() => {
          log.push("cleanup");
        });
        return new Class();
      },
    });
    expect(await handler()).toEqual({ ok: true });
    expect(log).toEqual(["cleanup"]);
  });

  it("still closes before an ordinary native Response settles, body unread", async () => {
    const log: string[] = [];

    @Controller("/stream")
    class NativeController {
      @Get()
      handle() {
        return jsonResponse({ native: true });
      }
    }

    const handler = routeHandler(NativeController, {
      controllerFactory: (Class, { onCleanup }) => {
        onCleanup(() => {
          log.push("cleanup");
        });
        return new Class();
      },
    });
    const response = (await handler()) as Response;
    expect(log).toEqual(["cleanup"]);
    expect(await response.json()).toEqual({ native: true });
  });

  it("does not treat an ordinary ReadableStream Response as owned", async () => {
    const log: string[] = [];

    @Controller("/stream")
    class RawStreamController {
      @Get()
      handle() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("raw"));
              controller.close();
            },
          }),
        );
      }
    }

    const handler = routeHandler(RawStreamController, {
      controllerFactory: (Class, { onCleanup }) => {
        onCleanup(() => {
          log.push("cleanup");
        });
        return new Class();
      },
    });
    const response = (await handler()) as Response;
    expect(log).toEqual(["cleanup"]);
    expect(await response.text()).toBe("raw");
  });
});

describe("concurrent streamed requests", () => {
  it("keeps request-scoped resources separate", async () => {
    const barrier = gate();
    const started = counter();
    const opened: string[] = [];
    const closed: string[] = [];

    @Controller("/stream")
    class ReaderController {
      constructor(readonly id: string) {}

      @Get()
      handle() {
        const { id } = this;
        return streamResponse(
          (async function* () {
            started.tick();
            await barrier.promise;
            yield `${id}-1;`;
            yield `${id}-2;`;
          })(),
        );
      }
    }

    let next = 0;
    const handler = routeHandler(ReaderController as unknown as ControllerClass, {
      controllerFactory: (Class, { onCleanup }) => {
        const id = `r${String((next += 1))}`;
        opened.push(id);
        onCleanup(() => {
          closed.push(id);
        });
        return new (Class as unknown as new (id: string) => object)(id);
      },
    });

    const [one, two] = (await Promise.all([handler(), handler()])) as [Response, Response];
    const bodies = Promise.all([one.text(), two.text()]);
    await started.reached(2);
    expect(closed).toEqual([]);
    barrier.open();
    expect(await bodies).toEqual(["r1-1;r1-2;", "r2-1;r2-2;"]);
    expect(opened).toEqual(["r1", "r2"]);
    expect([...closed].sort()).toEqual(["r1", "r2"]);

    // Cancelling one never touches the other.
    closed.length = 0;
    const [three, four] = (await Promise.all([handler(), handler()])) as [Response, Response];
    await three.body!.cancel();
    expect(closed).toEqual(["r3"]);
    expect(await four.text()).toBe("r4-1;r4-2;");
    expect(closed).toEqual(["r3", "r4"]);
  });
});

describe("private data", () => {
  it("keeps a canary out of the stream error body and the status line", async () => {
    const { handler } = setup(() =>
      streamResponse(
        (async function* () {
          yield "ok";
          throw new Error(CANARY);
        })(),
      ),
    );
    const response = (await handler()) as Response;
    expect(response.status).toBe(200);
    expect(response.statusText).not.toContain(CANARY);
    const received: string[] = [];
    const reader = bodyReader(response);
    for (;;) {
      try {
        const step = await reader.read();
        if (step.done) break;
        received.push(decoder.decode(step.value));
      } catch {
        break;
      }
    }
    expect(received.join("")).toBe("ok");
  });
});
