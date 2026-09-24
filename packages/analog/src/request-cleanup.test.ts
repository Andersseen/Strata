import { Controller, Get } from "@strata/core";
import { createApp, createRouter, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type {
  ControllerClass,
  RegisterControllersOptions,
  StrataAnalogControllerFactory,
  StrataAnalogControllerFactoryContext,
  StrataAnalogRequest,
} from "./register-controllers.js";

/**
 * Registers `controller` on a minimal router and returns its single route
 * handler, so a test can await exactly what Nitro would await — including the
 * raw error it rejects with, before H3 turns it into a 500.
 */
function routeHandler(
  controller: ControllerClass,
  options?: RegisterControllersOptions,
): () => Promise<unknown> {
  const handlers: Array<(event: object) => unknown> = [];

  registerControllers(
    {
      add(_path, handler) {
        handlers.push(handler);
      },
    },
    [controller],
    options,
  );

  const handler = handlers[0];

  if (!handler) {
    throw new Error("Expected registerControllers() to add a route handler.");
  }

  return () => Promise.resolve(handler({ path: "/cleanup" }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, resolve: release };
}

/** A factory that registers the given cleanups, then builds the controller. */
function factoryWith(
  ...cleanups: Array<() => void | Promise<void>>
): StrataAnalogControllerFactory {
  return (Controller, { onCleanup }) => {
    for (const cleanup of cleanups) {
      onCleanup(cleanup);
    }

    return new Controller();
  };
}

@Controller("/cleanup")
class OkController {
  @Get()
  async handle() {
    await Promise.resolve();

    return { ok: true };
  }
}

describe("registerControllers — request cleanup", () => {
  it("runs cleanup after a successful handler, once the handler's last await has settled", async () => {
    const log: string[] = [];

    @Controller("/cleanup")
    class LoggingController {
      @Get()
      async handle() {
        log.push("handler start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push("handler end");

        return { ok: true };
      }
    }

    const invoke = routeHandler(LoggingController, {
      controllerFactory: (Controller, { onCleanup }) => {
        log.push("factory");
        onCleanup(() => {
          log.push("cleanup");
        });

        return new Controller();
      },
    });

    await expect(invoke()).resolves.toEqual({ ok: true });
    expect(log).toEqual(["factory", "handler start", "handler end", "cleanup"]);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("handler failed");
      },
    ],
    ["rejects", () => Promise.reject(new Error("handler failed"))],
  ])("runs cleanup and rethrows the original error when the handler %s", async (_label, fail) => {
    const cleanup = vi.fn();

    @Controller("/cleanup")
    class FailingController {
      @Get()
      handle() {
        return fail();
      }
    }

    await expect(
      routeHandler(FailingController, { controllerFactory: factoryWith(cleanup) })(),
    ).rejects.toThrow("handler failed");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanups registered before a sync factory failure, without calling the handler", async () => {
    const failure = new Error("factory failed");
    const cleanup = vi.fn();
    const handler = vi.fn();

    @Controller("/cleanup")
    class NeverCalledController {
      @Get()
      handle() {
        handler();
      }
    }

    const invoke = routeHandler(NeverCalledController, {
      controllerFactory: (_Controller, { onCleanup }) => {
        onCleanup(cleanup);

        throw failure;
      },
    });

    await expect(invoke()).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs cleanups registered before an async factory rejection", async () => {
    const failure = new Error("initialization failed");
    const dispose = vi.fn<() => void>();

    const invoke = routeHandler(OkController, {
      controllerFactory: async (_Controller, { onCleanup }) => {
        const resource = { dispose };

        onCleanup(() => {
          resource.dispose();
        });
        await Promise.resolve();

        throw failure;
      },
    });

    await expect(invoke()).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("runs cleanups when the factory returns an invalid controller", async () => {
    const cleanup = vi.fn();

    const invoke = routeHandler(OkController, {
      controllerFactory: (_Controller, { onCleanup }) => {
        onCleanup(cleanup);

        return {};
      },
    });

    await expect(invoke()).rejects.toThrow(StrataAnalogConfigurationError);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("awaits async cleanup before the route handler settles", async () => {
    const released = deferred();
    let cleanupFinished = false;
    let settled = false;

    const invoke = routeHandler(OkController, {
      controllerFactory: factoryWith(async () => {
        await released.promise;
        cleanupFinished = true;
      }),
    });

    const invocation = invoke().then((result) => {
      settled = true;

      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    released.resolve();

    await expect(invocation).resolves.toEqual({ ok: true });
    expect(cleanupFinished).toBe(true);
  });

  it("finishes cleanup before Nitro/H3 sends the response", async () => {
    let cleanupFinished = false;

    const app = createApp();
    const router = createRouter({ preemptive: true });

    app.use(router.handler);
    registerControllers(router, [OkController], {
      controllerFactory: factoryWith(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        cleanupFinished = true;
      }),
    });

    const response = await toWebHandler(app)(new Request("http://localhost/cleanup"));

    expect(cleanupFinished).toBe(true);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("runs each registered cleanup exactly once per request", async () => {
    const cleanup = vi.fn();
    const invoke = routeHandler(OkController, { controllerFactory: factoryWith(cleanup) });

    await invoke();
    expect(cleanup).toHaveBeenCalledTimes(1);

    await invoke();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("runs cleanups last registered first, one at a time", async () => {
    const log: string[] = [];
    const cleanup = (name: string) => async () => {
      log.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      log.push(`${name} end`);
    };

    await routeHandler(OkController, {
      controllerFactory: factoryWith(cleanup("A"), cleanup("B"), cleanup("C")),
    })();

    expect(log).toEqual(["C start", "C end", "B start", "B end", "A start", "A end"]);
  });

  it("keeps running the remaining cleanups when one fails", async () => {
    const a = vi.fn();
    const c = vi.fn();

    await expect(
      routeHandler(OkController, {
        controllerFactory: factoryWith(
          a,
          () => {
            throw new Error("B failed");
          },
          c,
        ),
      })(),
    ).rejects.toThrow("B failed");
    expect(c).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("lets the factory and the handler receive the same request, with a destructurable onCleanup", async () => {
    let factoryRequest: StrataAnalogRequest | undefined;
    let handlerRequest: StrataAnalogRequest | undefined;
    let context: StrataAnalogControllerFactoryContext | undefined;

    @Controller("/cleanup")
    class RequestController {
      @Get()
      handle(request: StrataAnalogRequest) {
        handlerRequest = request;

        return {};
      }
    }

    await routeHandler(RequestController, {
      controllerFactory: (Controller, factoryContext) => {
        const { request, onCleanup } = factoryContext;

        context = factoryContext;
        factoryRequest = request;
        onCleanup(() => undefined);

        return new Controller();
      },
    })();

    expect(handlerRequest).toBeDefined();
    expect(handlerRequest).toBe(factoryRequest);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("keeps the default factory path unchanged", async () => {
    let constructed = 0;

    @Controller("/cleanup")
    class DefaultController {
      constructor() {
        constructed++;
      }

      @Get()
      handle() {
        return { ok: true };
      }
    }

    const invoke = routeHandler(DefaultController);

    await expect(invoke()).resolves.toEqual({ ok: true });
    await expect(invoke()).resolves.toEqual({ ok: true });
    expect(constructed).toBe(2);
  });

  it("rejects onCleanup() calls after the invocation has finished", async () => {
    let lateOnCleanup: StrataAnalogControllerFactoryContext["onCleanup"] | undefined;

    await routeHandler(OkController, {
      controllerFactory: (Controller, { onCleanup }) => {
        lateOnCleanup = onCleanup;

        return new Controller();
      },
    })();

    expect(() => lateOnCleanup?.(() => undefined)).toThrow(StrataAnalogConfigurationError);
  });

  it("rejects a non-function cleanup as a factory failure, still running earlier cleanups", async () => {
    const earlier = vi.fn();

    await expect(
      routeHandler(OkController, {
        controllerFactory: (Controller, { onCleanup }) => {
          onCleanup(earlier);
          onCleanup("nope" as unknown as () => void);

          return new Controller();
        },
      })(),
    ).rejects.toThrow(StrataAnalogConfigurationError);
    expect(earlier).toHaveBeenCalledTimes(1);
  });
});

describe("registerControllers — request cleanup errors", () => {
  const failingHandler = new Error("handler failed");

  @Controller("/cleanup")
  class FailingController {
    @Get()
    handle() {
      throw failingHandler;
    }
  }

  it("throws the cleanup error when the invocation succeeded and one cleanup failed", async () => {
    const cleanupError = new Error("cleanup failed");

    await expect(
      routeHandler(OkController, {
        controllerFactory: factoryWith(() => {
          throw cleanupError;
        }),
      })(),
    ).rejects.toBe(cleanupError);
  });

  it("throws an AggregateError of every cleanup error when the invocation succeeded and several failed", async () => {
    const errorA = new Error("A failed");
    const errorC = new Error("C failed");
    const b = vi.fn();

    const invocation = routeHandler(OkController, {
      controllerFactory: factoryWith(
        () => {
          throw errorA;
        },
        b,
        () => Promise.reject(errorC),
      ),
    })();

    await expect(invocation).rejects.toBeInstanceOf(AggregateError);
    await expect(invocation).rejects.toMatchObject({ errors: [errorC, errorA] });
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("rethrows the original error unchanged when the invocation failed and cleanups succeeded", async () => {
    const cleanup = vi.fn();

    await expect(
      routeHandler(FailingController, { controllerFactory: factoryWith(cleanup) })(),
    ).rejects.toBe(failingHandler);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("throws an AggregateError of the original error and every cleanup error when both failed", async () => {
    const errorA = new Error("A failed");
    const errorB = new Error("B failed");

    const invocation = routeHandler(FailingController, {
      controllerFactory: factoryWith(
        () => {
          throw errorA;
        },
        () => Promise.reject(errorB),
      ),
    })();

    await expect(invocation).rejects.toBeInstanceOf(AggregateError);
    await expect(invocation).rejects.toMatchObject({ errors: [failingHandler, errorB, errorA] });
  });

  it("aggregates a factory failure with a failing cleanup", async () => {
    const factoryError = new Error("factory failed");
    const cleanupError = new Error("cleanup failed");

    const invocation = routeHandler(OkController, {
      controllerFactory: (_Controller, { onCleanup }) => {
        onCleanup(() => {
          throw cleanupError;
        });

        throw factoryError;
      },
    })();

    await expect(invocation).rejects.toMatchObject({ errors: [factoryError, cleanupError] });
  });
});
