import { Controller, Get } from "@strata-sc/core";
import { registerControllers, streamResponse } from "@strata-sc/analog";
import type { NitroRouter, StrataAnalogControllerFactory } from "@strata-sc/analog";

/** A request-scoped resource whose lifetime matters: it must outlive the handler call. */
class OrderCursor {
  #open = true;

  async *rows(): AsyncGenerator<string> {
    for (let id = 1; id <= 3; id++) {
      if (!this.#open) throw new Error("cursor closed");
      yield `${JSON.stringify({ id })}\n`;
    }
  }

  close(): void {
    this.#open = false;
  }
}

@Controller("/api/example-orders")
class OrdersController {
  constructor(private readonly cursor: OrderCursor) {}

  @Get("/export")
  export() {
    return streamResponse(this.cursor.rows(), {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
}

const controllerFactory: StrataAnalogControllerFactory = (_Controller, { onCleanup }) => {
  const cursor = new OrderCursor();
  onCleanup(() => cursor.close());

  return new OrdersController(cursor);
};

export function registerOrderExport(router: NitroRouter): void {
  registerControllers(router, [OrdersController as new () => object], { controllerFactory });
}

// The helper is a plain, native Response: it passes through code that expects one.
export const typed: Response = streamResponse(
  (async function* () {
    yield "text";
    yield new Uint8Array([1]);
  })(),
);
export const body: ReadableStream<Uint8Array> | null = typed.body;
