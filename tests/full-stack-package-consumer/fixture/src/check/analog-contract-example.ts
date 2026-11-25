import { Controller, Get, Post } from "@strata-sc/core";
import { registerControllers, streamResponse } from "@strata-sc/analog";
import type {
  ControllerClass,
  ControllerConstructor,
  NitroRouter,
  StrataAnalogControllerFactory,
  StrataAnalogGuard,
} from "@strata-sc/analog";

/**
 * S-1 and S-2 (docs/research/pre-rc0-consolidation.md) from the installed declarations, under
 * TypeScript 6.0 and 5.9 with `skipLibCheck: false`. Compiled only for `@strata-sc/analog` 0.13.0
 * and later. Every `@ts-expect-error` must still find its error.
 */

class OrderCursor {
  async *rows(): AsyncGenerator<string> {
    yield "{}\n";
  }
  close(): void {}
}

// The package README's streaming example, without the cast it once needed.
@Controller("/api/contract-orders")
class OrdersController {
  constructor(private readonly cursor: OrderCursor) {}

  @Get("/export")
  export() {
    return streamResponse(this.cursor.rows());
  }

  @Post("/")
  create() {
    return { created: true };
  }
}

const controllerFactory: StrataAnalogControllerFactory<typeof OrdersController> = (
  _Controller,
  { onCleanup },
) => {
  const cursor = new OrderCursor();
  onCleanup(() => cursor.close());
  return new OrdersController(cursor);
};

@Controller("/api/contract-health")
class HealthController {
  @Get("/")
  read() {
    return { ok: true };
  }
}

const sameOrigin: StrataAnalogGuard = ({ request }) =>
  request.method === "GET" || request.headers.get("origin") === request.url.origin
    ? { allow: true }
    : { allow: false, status: 403 };

export function register(router: NitroRouter): void {
  registerControllers(router, [OrdersController], {
    controllerFactory,
    publicOrigin: "https://app.example.com",
    guards: [sameOrigin],
  });
  registerControllers(router, [HealthController]);

  // A generic factory over any constructor, as an injector-backed one would be.
  const viaRegistry =
    (registry: ReadonlyMap<ControllerConstructor, () => object>) =>
    (controller: ControllerConstructor): object =>
      registry.get(controller)?.() ?? new HealthController();
  const generic: StrataAnalogControllerFactory<ControllerConstructor> = viaRegistry(new Map());
  registerControllers(router, [OrdersController, HealthController], {
    controllerFactory: generic,
  });
}

export function rejected(router: NitroRouter): void {
  // @ts-expect-error a controller with a required constructor parameter needs a factory
  registerControllers(router, [OrdersController]);
  // @ts-expect-error the factory cannot construct it without its parameter
  registerControllers(router, [OrdersController], { controllerFactory: (C) => new C() });
  const zeroOnly: StrataAnalogControllerFactory = (C) => new C();
  // @ts-expect-error a factory for zero-argument classes cannot take it
  registerControllers(router, [OrdersController], { controllerFactory: zeroOnly });
  // @ts-expect-error publicOrigin is a string
  registerControllers(router, [HealthController], { publicOrigin: 443 });
  const zero: ControllerClass = HealthController;
  void zero;
}
