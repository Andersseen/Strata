import { Controller, Get } from "@strata-sc/core";

import { streamResponse } from "@strata-sc/analog";
import type { StrataAnalogControllerFactory, StrataAnalogRequest } from "@strata-sc/analog";

export const cursorLog: string[] = [];
export const gates = new Map<string, () => void>();

/** A request-scoped resource whose lifetime matters: reading it after close fails. */
class OrderCursor {
  #open = true;

  constructor(readonly id: string) {
    cursorLog.push(`open:${id}`);
  }

  async *rows(): AsyncGenerator<string> {
    for (let row = 1; row <= 3; row++) {
      if (row === 2) await new Promise<void>((resolve) => gates.set(this.id, resolve));
      if (!this.#open) throw new Error(`cursor ${this.id} was read after close`);
      yield `${JSON.stringify({ cursor: this.id, row })}\n`;
    }
  }

  close(): void {
    this.#open = false;
    cursorLog.push(`close:${this.id}`);
  }
}

@Controller("/api/orders")
export class OrdersExportController {
  constructor(private readonly cursor: OrderCursor | undefined = undefined) {}

  @Get("/export")
  export() {
    if (!this.cursor) throw new Error("the factory did not provide a cursor");

    return streamResponse(this.cursor.rows(), {
      headers: { "content-type": "application/x-ndjson" },
    });
  }
}

export const orderCursorFactory: StrataAnalogControllerFactory = (
  _Controller,
  { request, onCleanup },
) => {
  const cursor = new OrderCursor(streamId(request));
  onCleanup(() => cursor.close());

  return new OrdersExportController(cursor);
};

function streamId(request: StrataAnalogRequest): string {
  const id = request.query["id"];

  return typeof id === "string" ? id : "anonymous";
}
