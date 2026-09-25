import { Controller, Get } from "@strata-sc/core";
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

/** Same H3 v1 app + preemptive router shape Nitro 2 builds (see register-controllers.test.ts). */
function createNitroLikeApp(
  controllers: readonly ControllerClass[],
  options?: RegisterControllersOptions,
) {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(router.handler);
  registerControllers(router, controllers, options);

  const handle = toWebHandler(app);

  return (path: string) => handle(new Request(`http://localhost${path}`));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, resolve: release };
}

describe("registerControllers — request-scoped controller lifecycle", () => {
  it("gives every request its own controller state by default", async () => {
    @Controller("/counter")
    class CounterController {
      private count = 0;

      @Get()
      increment() {
        this.count++;

        return { count: this.count };
      }
    }

    const request = createNitroLikeApp([CounterController]);

    await expect((await request("/counter")).json()).resolves.toEqual({ count: 1 });
    await expect((await request("/counter")).json()).resolves.toEqual({ count: 1 });
  });

  it("does not construct controllers during registration", () => {
    const constructor = vi.fn();

    @Controller("/lazy")
    class LazyController {
      constructor() {
        constructor();
      }

      @Get()
      handle() {
        return {};
      }
    }

    const factory = vi.fn<StrataAnalogControllerFactory>((Controller) => new Controller());

    createNitroLikeApp([LazyController], { controllerFactory: factory });

    expect(constructor).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses a different controller instance for each request", async () => {
    const instances: object[] = [];

    @Controller("/identity")
    class IdentityController {
      @Get()
      handle() {
        instances.push(this);

        return {};
      }
    }

    const request = createNitroLikeApp([IdentityController]);

    await request("/identity");
    await request("/identity");

    expect(instances).toHaveLength(2);
    expect(instances[0]).toBeInstanceOf(IdentityController);
    expect(instances[1]).toBeInstanceOf(IdentityController);
    expect(instances[0]).not.toBe(instances[1]);
  });

  it("isolates controller state between concurrent requests", async () => {
    const bothCreated = deferred();
    const created: object[] = [];
    const handled: object[] = [];

    @Controller("/concurrent")
    class ConcurrentController {
      private requestId?: string;

      @Get()
      async handle(request: StrataAnalogRequest) {
        this.requestId = request.query["id"] as string;
        handled.push(this);

        // Both handlers are suspended here at the same time, with both
        // instances alive, before either reads its own state back.
        await bothCreated.promise;

        return { id: this.requestId };
      }
    }

    const request = createNitroLikeApp([ConcurrentController], {
      controllerFactory: (Controller) => {
        const controller = new Controller();

        created.push(controller);

        if (created.length === 2) {
          setTimeout(bothCreated.resolve, 0);
        }

        return controller;
      },
    });

    const [a, b] = await Promise.all([request("/concurrent?id=a"), request("/concurrent?id=b")]);

    await expect(a.json()).resolves.toEqual({ id: "a" });
    await expect(b.json()).resolves.toEqual({ id: "b" });
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    expect(handled).toEqual(created);
  });

  it("calls a custom sync factory once per request with the controller class and Strata request", async () => {
    @Controller("/sync")
    class SyncController {
      @Get()
      handle() {
        return { ok: true };
      }
    }

    const factory = vi.fn<StrataAnalogControllerFactory>((Controller) => new Controller());
    const request = createNitroLikeApp([SyncController], { controllerFactory: factory });

    await request("/sync?first");
    await request("/sync?second");

    expect(factory).toHaveBeenCalledTimes(2);

    const [controller, context] = factory.mock.calls[0] ?? [];

    expect(controller).toBe(SyncController);
    expect(context?.request).toMatchObject({ method: "GET", path: "/sync", query: { first: "" } });
    expect(context?.request).not.toHaveProperty("node");
    expect(context?.request).not.toHaveProperty("web");
    expect(factory.mock.calls[1]?.[1].request.query).toEqual({ second: "" });
  });

  it("awaits a custom async factory once per request", async () => {
    @Controller("/async")
    class AsyncController {
      prepared = false;

      @Get()
      handle() {
        return { prepared: this.prepared };
      }
    }

    const factory = vi.fn<StrataAnalogControllerFactory>(async (Controller) => {
      await Promise.resolve();

      const controller = new Controller() as AsyncController;

      controller.prepared = true;

      return controller;
    });
    const request = createNitroLikeApp([AsyncController], { controllerFactory: factory });

    await expect((await request("/async")).json()).resolves.toEqual({ prepared: true });
    await expect((await request("/async")).json()).resolves.toEqual({ prepared: true });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invokes the handler on the factory's instance with the request the factory received", async () => {
    const seen: { factory?: StrataAnalogControllerFactoryContext; controller?: object } = {};
    const handlerThis: object[] = [];
    let handlerRequest: StrataAnalogRequest | undefined;

    @Controller("/same")
    class SameController {
      @Get()
      handle(request: StrataAnalogRequest) {
        handlerThis.push(this);
        handlerRequest = request;

        return {};
      }
    }

    const request = createNitroLikeApp([SameController], {
      controllerFactory: (Controller, context) => {
        seen.factory = context;
        seen.controller = new Controller();

        return seen.controller;
      },
    });

    await request("/same");

    expect(handlerThis).toHaveLength(1);
    expect(handlerThis[0]).toBe(seen.controller);
    expect(handlerRequest).toBeDefined();
    expect(handlerRequest).toBe(seen.factory?.request);
  });

  it("lets a factory resolve external dependencies for the controller", async () => {
    class GreetingService {
      greet(name: string) {
        return `hello ${name}`;
      }
    }

    @Controller("/greeting")
    class GreetingController {
      constructor(private readonly greetings?: GreetingService) {}

      @Get()
      handle(request: StrataAnalogRequest) {
        return { message: this.greetings?.greet(request.query["name"] as string) ?? null };
      }
    }

    const greetings = new GreetingService();
    const request = createNitroLikeApp([GreetingController], {
      controllerFactory: (Controller) =>
        Controller === GreetingController ? new GreetingController(greetings) : new Controller(),
    });

    await expect((await request("/greeting?name=ada")).json()).resolves.toEqual({
      message: "hello ada",
    });
  });

  it("propagates a factory error to the runtime without calling the handler", async () => {
    const handler = vi.fn();
    const failure = new Error("dependency cannot be resolved");

    @Controller("/throws")
    class ThrowingController {
      @Get()
      handle() {
        handler();

        return {};
      }
    }

    const onError = vi.fn();
    const app = createApp({ onError });
    const router = createRouter({ preemptive: true });

    app.use(router.handler);
    registerControllers(router, [ThrowingController], {
      controllerFactory: () => {
        throw failure;
      },
    });

    const response = await toWebHandler(app)(new Request("http://localhost/throws"));

    expect(response.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as { cause?: unknown }).cause).toBe(failure);
  });

  it("propagates a factory rejection to the runtime without calling the handler", async () => {
    const handler = vi.fn();
    const failure = new Error("async dependency failed");

    @Controller("/rejects")
    class RejectingController {
      @Get()
      handle() {
        handler();

        return {};
      }
    }

    const onError = vi.fn();
    const app = createApp({ onError });
    const router = createRouter({ preemptive: true });

    app.use(router.handler);
    registerControllers(router, [RejectingController], {
      controllerFactory: () => Promise.reject(failure),
    });

    const response = await toWebHandler(app)(new Request("http://localhost/rejects"));

    expect(response.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
    expect((onError.mock.calls[0]?.[0] as { cause?: unknown }).cause).toBe(failure);
  });

  describe("invalid factory results", () => {
    @Controller("/invalid")
    class InvalidResultController {
      @Get()
      handle() {
        return {};
      }
    }

    class UnrelatedClass {}

    it.each([
      ["null", null, /returned null/],
      ["undefined", undefined, /returned undefined/],
      ["a primitive", 42, /returned a number/],
      ["a plain object", {}, /returned an instance of "Object"/],
      ["an unrelated instance", new UnrelatedClass(), /returned an instance of "UnrelatedClass"/],
    ])("rejects %s with a configuration error", async (_label, result, message) => {
      const router = { handlers: [] as Array<(event: object) => unknown> };

      registerControllers(
        {
          add(_path, handler) {
            router.handlers.push(handler);
          },
        },
        [InvalidResultController],
        { controllerFactory: () => result as object },
      );

      const handler = router.handlers[0];

      if (!handler) {
        throw new Error("Expected registerControllers() to add a route handler.");
      }

      const invocation = Promise.resolve(handler({ path: "/invalid" }));

      await expect(invocation).rejects.toThrow(StrataAnalogConfigurationError);
      await expect(invocation).rejects.toThrow(message);
      await expect(invocation).rejects.toThrow(
        /must return an instance of "InvalidResultController"/,
      );
    });
  });

  it("throws at registration when controllerFactory is not a function", () => {
    @Controller("/options")
    class OptionsController {
      @Get()
      handle() {
        return {};
      }
    }

    expect(() =>
      createNitroLikeApp([OptionsController], {
        controllerFactory: "nope" as unknown as StrataAnalogControllerFactory,
      }),
    ).toThrow(StrataAnalogConfigurationError);
  });
});

describe("registerControllers — handler validation without instances", () => {
  it("accepts handlers inherited through the prototype chain", async () => {
    class BaseController {
      handle() {
        return { from: "base" };
      }
    }

    @Controller("/inherited")
    class InheritedController extends BaseController {
      @Get()
      override handle() {
        return { from: "child", base: super.handle().from };
      }
    }

    const request = createNitroLikeApp([InheritedController]);

    await expect((await request("/inherited")).json()).resolves.toEqual({
      from: "child",
      base: "base",
    });
  });

  it("rejects a handler that is a getter without invoking it", () => {
    const getter = vi.fn(() => () => ({}));

    @Controller("/getter")
    class GetterController {
      @Get()
      handle() {
        return {};
      }
    }

    Object.defineProperty(GetterController.prototype, "handle", {
      get: getter,
      configurable: true,
    });

    expect(() => createNitroLikeApp([GetterController])).toThrow(StrataAnalogConfigurationError);
    expect(() => createNitroLikeApp([GetterController])).toThrow(/GetterController\.handle/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects a handler that only exists on instances, not on the prototype", () => {
    @Controller("/field")
    class FieldController {
      @Get()
      handle() {
        return {};
      }
    }

    // Metadata points at a name the prototype chain does not define as a method.
    delete (FieldController.prototype as { handle?: unknown }).handle;

    expect(() => createNitroLikeApp([FieldController])).toThrow(/FieldController\.handle/);
  });
});
