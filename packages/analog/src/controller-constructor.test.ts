import { Controller, Get } from "@strata-sc/core";
import { createApp, createRouter, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type {
  ControllerClass,
  ControllerConstructor,
  NitroRouter,
  StrataAnalogControllerFactory,
  StrataAnalogGuard,
  StrataAnalogInterceptor,
} from "./register-controllers.js";

/**
 * S-2 (docs/research/pre-rc0-consolidation.md): controllers whose constructors take parameters
 * are registered with the factory that builds them; without a factory, only classes Strata can
 * construct with `new Controller()` are accepted. The compile-time half is enforced by
 * `pnpm typecheck` (this file is part of it) and, from installed declarations, by
 * `pnpm test:full-stack-package-consumer` under TypeScript 6.0 and 5.9.
 */

class OrderStore {
  constructor(readonly tenant: string) {}
}

@Controller("/zero")
class ZeroController {
  @Get("/")
  read() {
    return { kind: "zero" };
  }
}

@Controller("/optional")
class OptionalController {
  constructor(private readonly store?: OrderStore) {}

  @Get("/")
  read() {
    return { tenant: this.store?.tenant ?? null };
  }
}

@Controller("/orders")
class OrdersController {
  constructor(private readonly store: OrderStore) {}

  @Get("/")
  read() {
    return { tenant: this.store.tenant };
  }
}

class BaseController {
  constructor(protected readonly store: OrderStore) {}

  /** Inherited behaviour, not a route: a subclass registers only its own decorated routes. */
  protected label(): string {
    return `base:${this.store.tenant}`;
  }
}

@Controller("/derived")
class DerivedController extends BaseController {
  constructor(
    store: OrderStore,
    private readonly suffix: string,
  ) {
    super(store);
  }

  @Get("/own")
  own() {
    return { tenant: `${this.store.tenant}${this.suffix}`, label: this.label() };
  }
}

function app() {
  const h3 = createApp();
  const router = createRouter({ preemptive: true });
  h3.use(router.handler);
  const handle = toWebHandler(h3);
  return {
    router,
    get: async (path: string) => {
      const response = await handle(new Request(`http://localhost${path}`));
      const body: unknown = await response.json();
      return { status: response.status, body };
    },
  };
}

/** A tiny consumer-owned registry standing in for an injector: not something Strata provides. */
function registryFactory(
  build: ReadonlyMap<ControllerConstructor, () => object>,
): StrataAnalogControllerFactory<ControllerConstructor> {
  return (controller) => {
    const create = build.get(controller);
    if (!create) throw new Error(`no provider for ${controller.name}`);
    return create();
  };
}

describe("controllers without constructor parameters", () => {
  it("keep working without a factory, optional parameters included", async () => {
    const { router, get } = app();
    registerControllers(router, [ZeroController, OptionalController]);

    expect(await get("/zero")).toEqual({ status: 200, body: { kind: "zero" } });
    expect(await get("/optional")).toEqual({ status: 200, body: { tenant: null } });
  });

  it("can still be built by a zero-argument factory typed the old way", async () => {
    const { router, get } = app();
    const factory: StrataAnalogControllerFactory = (Controller) => new Controller();
    registerControllers(router, [ZeroController], { controllerFactory: factory });

    expect((await get("/zero")).status).toBe(200);
  });
});

describe("controllers with constructor parameters", () => {
  it("are built by the factory, which receives the registered class itself", async () => {
    const { router, get } = app();
    const seen: unknown[] = [];
    registerControllers(router, [OrdersController], {
      controllerFactory: (Controller) => {
        seen.push(Controller);
        return new Controller(new OrderStore("alpha"));
      },
    });

    expect(await get("/orders")).toEqual({ status: 200, body: { tenant: "alpha" } });
    expect(seen).toEqual([OrdersController]);
  });

  it("can be typed with the exact class, as the package README does", async () => {
    const { router, get } = app();
    const factory: StrataAnalogControllerFactory<typeof OrdersController> = () =>
      new OrdersController(new OrderStore("typed"));
    registerControllers(router, [OrdersController], { controllerFactory: factory });

    expect((await get("/orders")).body).toEqual({ tenant: "typed" });
  });

  it("can share one factory with zero-argument and optional-parameter controllers", async () => {
    const { router, get } = app();
    const store = new OrderStore("shared");
    registerControllers(router, [ZeroController, OptionalController, OrdersController], {
      controllerFactory: registryFactory(
        new Map<ControllerConstructor, () => object>([
          [ZeroController, () => new ZeroController()],
          [OptionalController, () => new OptionalController(store)],
          [OrdersController, () => new OrdersController(store)],
        ]),
      ),
    });

    expect((await get("/zero")).body).toEqual({ kind: "zero" });
    expect((await get("/optional")).body).toEqual({ tenant: "shared" });
    expect((await get("/orders")).body).toEqual({ tenant: "shared" });
  });

  it("keep the base class's constructor state and methods in a subclass", async () => {
    const { router, get } = app();
    const seen: unknown[] = [];
    registerControllers(router, [DerivedController], {
      controllerFactory: (Controller) => {
        seen.push(Controller);
        return new Controller(new OrderStore("beta"), "-x");
      },
    });

    expect((await get("/derived/own")).body).toEqual({ tenant: "beta-x", label: "base:beta" });
    expect(seen).toEqual([DerivedController]);
  });

  it("still refuse a factory result that is not an instance, after running its cleanups", async () => {
    const onError = vi.fn();
    const h3 = createApp({ onError });
    const router = createRouter({ preemptive: true });
    h3.use(router.handler);
    const cleanup = vi.fn();
    registerControllers(router, [OrdersController], {
      controllerFactory: (_Controller, { onCleanup }) => {
        onCleanup(cleanup);
        return new ZeroController();
      },
    });

    const response = await toWebHandler(h3)(new Request("http://localhost/orders"));

    expect(response.status).toBe(500);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const cause = (onError.mock.calls[0]?.[0] as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(StrataAnalogConfigurationError);
    expect(String(cause)).toMatch(
      /returned an instance of "ZeroController" for "OrdersController"/,
    );
  });

  it("run the factory's cleanups when it rejects, and never call the handler", async () => {
    const onError = vi.fn();
    const h3 = createApp({ onError });
    const router = createRouter({ preemptive: true });
    h3.use(router.handler);
    const cleanup = vi.fn();
    const failure = new Error("store unavailable");
    registerControllers(router, [OrdersController], {
      controllerFactory: async (_Controller, { onCleanup }) => {
        onCleanup(cleanup);
        await Promise.resolve();
        throw failure;
      },
    });

    const response = await toWebHandler(h3)(new Request("http://localhost/orders"));

    expect(response.status).toBe(500);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as { cause?: unknown }).cause).toBe(failure);
  });

  it("run guards before construction and interceptors around it", async () => {
    const { router, get } = app();
    const order: string[] = [];
    const guard: StrataAnalogGuard = ({ request }) => {
      order.push("guard");
      return request.query["deny"] === "1" ? { allow: false, status: 403 } : { allow: true };
    };
    const interceptor: StrataAnalogInterceptor = async (_context, next) => {
      order.push("before");
      const result = await next();
      order.push("after");
      return result;
    };
    registerControllers(router, [OrdersController], {
      guards: [guard],
      interceptors: [interceptor],
      controllerFactory: (Controller) => {
        order.push("factory");
        return new Controller(new OrderStore("guarded"));
      },
    });

    expect((await get("/orders?deny=1")).status).toBe(403);
    expect(order).toEqual(["guard"]);
    order.length = 0;
    expect((await get("/orders")).body).toEqual({ tenant: "guarded" });
    expect(order).toEqual(["guard", "before", "factory", "after"]);
  });
});

/**
 * Compile-time contract. Never called: `pnpm typecheck` fails if any expectation below changes,
 * including an `@ts-expect-error` whose error disappears.
 */
export function typeContract(router: NitroRouter): void {
  // @ts-expect-error a controller with a required parameter needs a factory
  registerControllers(router, [OrdersController]);
  // @ts-expect-error ...also when it hides among zero-argument controllers
  registerControllers(router, [ZeroController, OrdersController]);
  // @ts-expect-error the factory cannot call `new` without the parameter
  registerControllers(router, [OrdersController], { controllerFactory: (C) => new C() });

  const zeroOnly: StrataAnalogControllerFactory = (C) => new C();
  // @ts-expect-error a factory typed for zero-argument classes cannot take one that needs a store
  registerControllers(router, [OrdersController], { controllerFactory: zeroOnly });
  // @ts-expect-error a generic factory has no arguments to pass `new` either
  const unsafe: StrataAnalogControllerFactory<ControllerConstructor> = (C) => new C();

  registerControllers(router, [ZeroController, OptionalController]);
  registerControllers(router, [ZeroController], { controllerFactory: zeroOnly });
  registerControllers(router, [OrdersController, ZeroController], {
    controllerFactory: (C) => new C(new OrderStore("t")),
  });

  const zero: ControllerClass = OptionalController;
  void [unsafe, zero];
}
