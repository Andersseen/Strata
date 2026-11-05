import { createServer } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import { Controller, Get, Post } from "@strata-sc/core";
import { createApp, createRouter, eventHandler, toNodeListener } from "h3";
import { afterEach, describe, expect, it } from "vitest";

import { registerControllers } from "./register-controllers.js";
import type { StrataAnalogRequest } from "./register-controllers.js";

/**
 * A body over the validated-reader limit is answered with 413 while the client may still be
 * sending it. Strata must not destroy that request message: when it is destroyed before Node's
 * parser has completed it, the keep-alive connection falls out of step and the NEXT request on it
 * fails with a bare `400 Bad Request` from Node (reproduced on Nitro node-server; behind a proxy
 * that reuses upstream connections, that next request may be another client's). The remainder is
 * drained and discarded, as Node does for any body a handler never reads.
 *
 * Real `node:http` server with H3 v1's `toNodeListener` (what Nitro's node-server preset mounts)
 * and a raw socket, so ONE connection is reused explicitly. The limit is crossed while the
 * declared body is still incomplete — the race the production server loses — deterministically:
 * the tail of the body is only sent after the 413 has arrived.
 */

const LIMIT = 1024 * 1024;
const TAIL = 4096;
const anything = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
};

@Controller("/items")
class ItemsController {
  @Post("/json")
  json(request: StrataAnalogRequest) {
    return request.readValidatedJson(anything);
  }

  @Post("/form")
  form(request: StrataAnalogRequest) {
    return request.readValidatedForm(anything);
  }

  @Get("/ok")
  ok() {
    return { ok: true };
  }
}

let server: Server | undefined;
/** The request message's state at the moment each response finished, in order. */
let atResponseEnd: { destroyed: boolean; complete: boolean }[] = [];

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  atResponseEnd = [];
});

async function listen(): Promise<number> {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(
    eventHandler((event) => {
      const { req, res } = event.node;
      res.on("finish", () =>
        atResponseEnd.push({ destroyed: req.destroyed, complete: req.complete }),
      );
    }),
  );
  app.use(router.handler);
  registerControllers(router, [ItemsController]);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));

  return (server.address() as AddressInfo).port;
}

const nextRequest = "GET /items/ok HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n";

/**
 * Sends a POST whose body is `head + tail` bytes long, but only `head` bytes at first. Once the
 * first response has arrived it sends the tail, then `nextRequest`, on the same socket.
 * Resolves the status line of every response read before the socket closed.
 */
function oversizedThenNext(
  port: number,
  path: string,
  type: string,
  head: string,
  tail: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    let continued = false;

    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (!continued && /\r\n0\r\n\r\n|"source":"body"\}/.test(received)) {
        continued = true;
        socket.write(tail, "latin1");
        socket.write(nextRequest, "latin1");
      }
    });
    socket.on("error", reject);
    socket.on("close", () =>
      resolve([...received.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((match) => match[1]!)),
    );
    socket.write(
      `POST ${path} HTTP/1.1\r\nhost: localhost\r\ncontent-type: ${type}\r\n` +
        `content-length: ${head.length + tail.length}\r\nconnection: keep-alive\r\n\r\n${head}`,
      "latin1",
    );
    setTimeout(() => socket.destroy(), 10_000).unref();
  });
}

describe("validated body limits on a reused Node keep-alive connection", () => {
  // The deterministic part of the regression. The connection outcome below depends on a race
  // with Node's parser that a plain H3 server rarely loses but Nitro's node-server lost every
  // time (docs/research/m3-m4-contract-stabilization.md): the fix is that the message, still
  // incomplete when the 413 is sent, is never destroyed but drained.
  it("does not destroy the still-incomplete request message when the limit is crossed", async () => {
    const port = await listen();

    await oversizedThenNext(
      port,
      "/items/json",
      "application/json",
      `{"value":"${"x".repeat(LIMIT)}`,
      `${"x".repeat(TAIL)}"}`,
    );

    expect(atResponseEnd[0]).toEqual({ destroyed: false, complete: false });
  });

  it("answers 413 for an oversized JSON body and then serves the next request", async () => {
    const port = await listen();
    const statuses = await oversizedThenNext(
      port,
      "/items/json",
      "application/json",
      `{"value":"${"x".repeat(LIMIT)}`,
      `${"x".repeat(TAIL)}"}`,
    );

    expect(statuses).toEqual(["413", "200"]);
  });

  it("answers 413 for an oversized form body and then serves the next request", async () => {
    const port = await listen();
    const statuses = await oversizedThenNext(
      port,
      "/items/form",
      "application/x-www-form-urlencoded",
      `value=${"x".repeat(LIMIT)}`,
      "x".repeat(TAIL),
    );

    expect(statuses).toEqual(["413", "200"]);
  });

  it("keeps serving the connection after a 415 that never read the body (control)", async () => {
    const port = await listen();
    const statuses = await oversizedThenNext(port, "/items/json", "text/plain", "{", "}");

    expect(statuses).toEqual(["415", "200"]);
  });
});
