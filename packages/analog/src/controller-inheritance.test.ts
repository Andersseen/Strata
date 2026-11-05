import { Controller, Get } from "@strata-sc/core";
import { createApp, createRouter, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type { ControllerClass, NitroRouter } from "./register-controllers.js";

/** Same H3 v1 app + preemptive router shape Nitro 2 builds (see register-controllers.test.ts). */
function createNitroLikeApp(controllers: readonly ControllerClass[]) {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(router.handler);
  registerControllers(router, controllers);

  const handle = toWebHandler(app);

  return (path: string) => handle(new Request(`http://localhost${path}`));
}

function recordingRouter(): NitroRouter & { paths: () => string[] } {
  const add = vi.fn<NitroRouter["add"]>();

  return { add, paths: () => add.mock.calls.map(([path]) => path) };
}

describe("registerControllers — controller inheritance", () => {
  it("rejects an undecorated subclass of a controller without registering the base's routes", () => {
    @Controller("/base")
    class BaseController {
      @Get()
      base() {
        return { from: "base" };
      }
    }

    class UndecoratedChild extends BaseController {}

    const router = recordingRouter();

    expect(() => registerControllers(router, [UndecoratedChild])).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(() => registerControllers(router, [UndecoratedChild])).toThrow(
      /"UndecoratedChild" is not a Strata controller/,
    );
    expect(router.paths()).toEqual([]);
  });

  it("registers only a decorated subclass's own routes", () => {
    @Controller("/base")
    class BaseController {
      @Get("/shared")
      shared() {
        return {};
      }
    }

    @Controller("/child")
    class ChildController extends BaseController {
      @Get("/own")
      own() {
        return {};
      }
    }

    const router = recordingRouter();

    registerControllers(router, [ChildController]);

    expect(router.paths()).toEqual(["/child/own"]);
  });

  it("serves a decorated parent and child independently, each on its own instance", async () => {
    const instances: string[] = [];

    @Controller("/base")
    class BaseController {
      constructor() {
        instances.push(new.target.name);
      }

      @Get("/one")
      one() {
        return { route: "one", controller: this.constructor.name };
      }
    }

    @Controller("/child")
    class ChildController extends BaseController {
      @Get("/two")
      two() {
        return { route: "two", controller: this.constructor.name };
      }
    }

    const request = createNitroLikeApp([BaseController, ChildController]);

    expect(instances).toEqual([]);

    const [baseOne, childTwo, baseTwo, childOne] = await Promise.all([
      request("/base/one"),
      request("/child/two"),
      request("/base/two"),
      request("/child/one"),
    ]);

    await expect(baseOne.json()).resolves.toEqual({ route: "one", controller: "BaseController" });
    await expect(childTwo.json()).resolves.toEqual({ route: "two", controller: "ChildController" });
    expect(baseTwo.status).toBe(404);
    expect(childOne.status).toBe(404);
    expect(instances.sort()).toEqual(["BaseController", "ChildController"]);
  });

  it("serves a re-decorated override from the child and the original from the parent", async () => {
    @Controller("/base")
    class BaseController {
      @Get("/item")
      item() {
        return { implementation: "base" };
      }
    }

    @Controller("/child")
    class ChildController extends BaseController {
      @Get("/item")
      override item() {
        return { implementation: "child" };
      }
    }

    const request = createNitroLikeApp([BaseController, ChildController]);
    const [base, child] = await Promise.all([request("/base/item"), request("/child/item")]);

    await expect(base.json()).resolves.toEqual({ implementation: "base" });
    await expect(child.json()).resolves.toEqual({ implementation: "child" });
  });

  it("does not register or reroute an undecorated override of a parent's route", async () => {
    @Controller("/base")
    class BaseController {
      @Get("/item")
      item() {
        return { implementation: "base" };
      }
    }

    @Controller("/child")
    class ChildController extends BaseController {
      override item() {
        return { implementation: "child" };
      }
    }

    const router = recordingRouter();

    registerControllers(router, [ChildController]);
    expect(router.paths()).toEqual([]);

    const request = createNitroLikeApp([BaseController, ChildController]);
    const [base, child] = await Promise.all([request("/base/item"), request("/child/item")]);

    await expect(base.json()).resolves.toEqual({ implementation: "base" });
    expect(child.status).toBe(404);
  });

  // Current contract, pinned: the handler is resolved once, at registration, on the registered
  // class's prototype chain. A factory may return a subclass instance (it passes the instanceof
  // check and is `this`), but the registered method runs, not the subclass override.
  it("calls the registered method, not a subclass override, when the factory returns a subclass", async () => {
    @Controller("/base")
    class BaseController {
      @Get("/item")
      item() {
        return { implementation: "base", instance: this.constructor.name };
      }
    }

    class SubstituteController extends BaseController {
      override item() {
        return { implementation: "substitute", instance: this.constructor.name };
      }
    }

    const app = createApp();
    const router = createRouter({ preemptive: true });

    app.use(router.handler);
    registerControllers(router, [BaseController], {
      controllerFactory: () => new SubstituteController(),
    });

    const response = await toWebHandler(app)(new Request("http://localhost/base/item"));

    await expect(response.json()).resolves.toEqual({
      implementation: "base",
      instance: "SubstituteController",
    });
  });
});
