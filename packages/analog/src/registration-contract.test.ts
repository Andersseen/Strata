import { Controller, Delete, Get, Patch, Post } from "@strata-sc/core";
import { createApp, createRouter, defineEventHandler, toWebHandler } from "h3";
import { describe, expect, it } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type { NitroRouter } from "./register-controllers.js";

/**
 * A structural `NitroRouter` that records every `add()` call. `failOn` makes
 * `add()` throw for one path, to simulate the external router failing
 * mid-commit.
 */
function createRecordingRouter(failOn?: string) {
  const added: string[] = [];
  const router: NitroRouter = {
    add(path, _handler, method) {
      if (path === failOn) {
        throw new Error(`router refused ${path}`);
      }

      added.push(`${method.toUpperCase()} ${path}`);
    },
  };

  return { router, added };
}

function createNitroLikeApp() {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(router.handler);

  const handle = toWebHandler(app);

  return {
    router,
    request: (path: string) => handle(new Request(`http://localhost${path}`)),
  };
}

@Controller("/users")
class UsersController {
  @Get()
  list() {
    return "users";
  }
}

@Controller("/users")
class OtherUsersController {
  @Get()
  list() {
    return "other users";
  }
}

@Controller("/orders")
class OrdersController {
  @Get()
  list() {
    return "orders";
  }
}

@Controller("/valid")
class ValidController {
  @Get()
  valid() {
    return "valid";
  }
}

/** `toThrow()` matches a string as a substring of the error message. */
const duplicateError = (key: string) => `Duplicate Strata route "${key}"`;

describe("registerControllers — whole-batch preflight", () => {
  it("adds nothing when a later controller is not a Strata controller", () => {
    class InvalidController {
      @Get()
      invalid() {}
    }

    const { router, added } = createRecordingRouter();

    expect(() => registerControllers(router, [ValidController, InvalidController])).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(added).toEqual([]);
  });

  it("adds nothing when a later controller has a non-callable handler", () => {
    @Controller("/broken")
    class BrokenController {
      @Get()
      broken() {}
    }

    Object.defineProperty(BrokenController.prototype, "broken", {
      value: 42,
      configurable: true,
    });

    const { router, added } = createRecordingRouter();

    expect(() => registerControllers(router, [ValidController, BrokenController])).toThrow(
      /BrokenController\.broken/,
    );
    expect(added).toEqual([]);
  });

  it("adds nothing when a value in the list is not a class", () => {
    const { router, added } = createRecordingRouter();

    expect(() =>
      registerControllers(router, [ValidController, null as unknown as typeof ValidController]),
    ).toThrow(StrataAnalogConfigurationError);
    expect(added).toEqual([]);
  });

  it("validates controllerFactory before any registration", () => {
    const { router, added } = createRecordingRouter();

    expect(() =>
      registerControllers(router, [ValidController], {
        controllerFactory: "nope" as never,
      }),
    ).toThrow(/controllerFactory/);
    expect(added).toEqual([]);
  });

  it("rejects two routes of one controller with the same final path", () => {
    @Controller("/users")
    class DuplicateRoutesController {
      @Get()
      first() {}

      @Get("/")
      second() {}
    }

    const { router, added } = createRecordingRouter();

    expect(() => registerControllers(router, [DuplicateRoutesController])).toThrow(
      duplicateError("GET /users"),
    );
    expect(() => registerControllers(router, [DuplicateRoutesController])).toThrow(
      /"DuplicateRoutesController\.second" conflicts with "DuplicateRoutesController\.first"/,
    );
    expect(added).toEqual([]);
  });

  it("rejects the same route declared by two controllers in one call", () => {
    const { router, added } = createRecordingRouter();

    expect(() =>
      registerControllers(router, [OrdersController, UsersController, OtherUsersController]),
    ).toThrow(/"OtherUsersController\.list" conflicts with "UsersController\.list"/);
    expect(added).toEqual([]);
  });

  it("compares final paths, not controller and route path fragments", () => {
    @Controller("/api/users")
    class NestedController {
      @Get("/")
      list() {}
    }

    @Controller("/api")
    class FlatController {
      @Get("/users")
      users() {}
    }

    const { router, added } = createRecordingRouter();

    expect(() => registerControllers(router, [NestedController, FlatController])).toThrow(
      duplicateError("GET /api/users"),
    );
    expect(added).toEqual([]);
  });

  it("rejects the same controller listed twice", () => {
    const { router, added } = createRecordingRouter();

    expect(() => registerControllers(router, [UsersController, UsersController])).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(() => registerControllers(router, [UsersController, UsersController])).toThrow(
      duplicateError("GET /users"),
    );
    expect(added).toEqual([]);
  });

  it("treats an empty list and a controller without routes as no-ops", () => {
    @Controller("/empty")
    class EmptyController {}

    const { router, added } = createRecordingRouter();

    expect(registerControllers(router, [])).toBe(router);
    expect(registerControllers(router, [EmptyController, EmptyController])).toBe(router);
    // `/empty` has no route, so nothing reserves it.
    expect(() => registerControllers(router, [EmptyController])).not.toThrow();
    expect(added).toEqual([]);
  });

  it("adds routes in controller order, then route declaration order", () => {
    @Controller("/a")
    class ControllerA {
      @Get("/2")
      two() {}

      @Get("/1")
      one() {}
    }

    @Controller("/b")
    class ControllerB {
      @Get("/1")
      one() {}
    }

    const { router, added } = createRecordingRouter();

    registerControllers(router, [ControllerA, ControllerB]);

    expect(added).toEqual(["GET /a/2", "GET /a/1", "GET /b/1"]);
  });
});

describe("registerControllers — repeated calls on a router", () => {
  it("rejects registering the same controller again", () => {
    const { router, added } = createRecordingRouter();

    registerControllers(router, [UsersController]);

    expect(() => registerControllers(router, [UsersController])).toThrow(
      /"GET \/users".*already registered on this router/,
    );
    expect(added).toEqual(["GET /users"]);
  });

  it("rejects another controller's route that an earlier call already owns", () => {
    const { router, added } = createRecordingRouter();

    registerControllers(router, [UsersController]);

    expect(() => registerControllers(router, [OtherUsersController])).toThrow(
      /"OtherUsersController\.list" conflicts with "UsersController\.list"/,
    );
    expect(added).toEqual(["GET /users"]);
  });

  it("rejects a conflicting batch without adding its free routes", () => {
    const { router, added } = createRecordingRouter();

    registerControllers(router, [UsersController]);

    expect(() => registerControllers(router, [OrdersController, OtherUsersController])).toThrow(
      duplicateError("GET /users"),
    );
    expect(added).toEqual(["GET /users"]);
  });

  it("accepts calls with non-overlapping routes", () => {
    const { router, added } = createRecordingRouter();

    registerControllers(router, [UsersController]);
    registerControllers(router, [OrdersController]);

    expect(added).toEqual(["GET /users", "GET /orders"]);
  });

  it("keeps routers independent", () => {
    const first = createRecordingRouter();
    const second = createRecordingRouter();

    registerControllers(first.router, [UsersController]);
    registerControllers(second.router, [UsersController]);

    expect(first.added).toEqual(["GET /users"]);
    expect(second.added).toEqual(["GET /users"]);
  });

  it("reserves no route for a batch that failed preflight", () => {
    class InvalidController {}

    const { router, added } = createRecordingRouter();

    expect(() => registerControllers(router, [OrdersController, InvalidController])).toThrow(
      StrataAnalogConfigurationError,
    );

    registerControllers(router, [OrdersController]);

    expect(added).toEqual(["GET /orders"]);
  });
});

describe("registerControllers — router.add() failure during commit", () => {
  it("propagates the router's error and remembers only the routes it accepted", () => {
    @Controller()
    class TwoRoutesController {
      @Get("/first")
      first() {}

      @Get("/second")
      second() {}
    }

    @Controller()
    class FirstAgainController {
      @Get("/first")
      first() {}
    }

    @Controller()
    class SecondAgainController {
      @Get("/second")
      second() {}
    }

    const { router, added } = createRecordingRouter("/second");

    expect(() => registerControllers(router, [TwoRoutesController])).toThrow(
      "router refused /second",
    );
    expect(added).toEqual(["GET /first"]);

    // `/first` was committed, so Strata owns it; `/second` was not.
    expect(() => registerControllers(router, [FirstAgainController])).toThrow(
      duplicateError("GET /first"),
    );
    expect(() => registerControllers(router, [SecondAgainController])).toThrow(
      "router refused /second",
    );
  });
});

describe("registerControllers — native routes", () => {
  it("only detects Strata duplicates, never native routes already on the router", () => {
    const { router } = createNitroLikeApp();

    // Strata cannot see native routes, so it neither guesses at conflicts nor
    // rejects them; which handler answers is the router's business.
    router.get(
      "/users",
      defineEventHandler(() => ({ source: "analog" })),
    );

    expect(() => registerControllers(router, [UsersController])).not.toThrow();
  });

  it("keeps a native route on another path working", async () => {
    const { router, request } = createNitroLikeApp();

    router.get(
      "/api/native",
      defineEventHandler(() => ({ source: "analog" })),
    );

    registerControllers(router, [UsersController]);

    await expect((await request("/api/native")).json()).resolves.toEqual({ source: "analog" });
    await expect((await request("/users")).text()).resolves.toBe("users");
  });
});

describe("registerControllers — route identity is HTTP method + final path", () => {
  @Controller("/users")
  class ListAndCreateController {
    @Get()
    list() {
      return { handler: "list" };
    }

    @Post()
    create() {
      return { handler: "create" };
    }
  }

  @Controller("/users")
  class OtherCreateController {
    @Post()
    create() {}
  }

  it("registers GET and POST on the same path as two routes", async () => {
    const { router, request } = createNitroLikeApp();

    expect(() => registerControllers(router, [ListAndCreateController])).not.toThrow();
    await expect((await request("/users")).json()).resolves.toEqual({ handler: "list" });
  });

  it("still rejects a second POST on that path", () => {
    const { router, added } = createRecordingRouter();

    registerControllers(router, [ListAndCreateController]);

    expect(() => registerControllers(router, [OtherCreateController])).toThrow(
      StrataAnalogConfigurationError,
    );
    expect(() => registerControllers(router, [OtherCreateController])).toThrow(
      /"POST \/users".*"OtherCreateController\.create" conflicts with "ListAndCreateController\.create"/,
    );
    expect(added).toEqual(["GET /users", "POST /users"]);
  });

  it("accepts GET, POST, PATCH and DELETE on one path, but not two PATCH routes", () => {
    @Controller("/resource")
    class ResourceController {
      @Get()
      read() {}

      @Post()
      create() {}

      @Patch()
      update() {}

      @Delete()
      remove() {}
    }

    @Controller("/resource")
    class DoublePatchController {
      @Patch()
      first() {}

      @Patch("/")
      second() {}
    }

    const valid = createRecordingRouter();

    registerControllers(valid.router, [ResourceController]);

    expect(valid.added).toEqual([
      "GET /resource",
      "POST /resource",
      "PATCH /resource",
      "DELETE /resource",
    ]);

    const invalid = createRecordingRouter();

    expect(() => registerControllers(invalid.router, [DoublePatchController])).toThrow(
      duplicateError("PATCH /resource"),
    );
    expect(invalid.added).toEqual([]);
  });
});
