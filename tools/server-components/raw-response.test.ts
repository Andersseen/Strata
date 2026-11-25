import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";

import { describe, it } from "vitest";

import { rawResponseBody } from "./lib/full-stack-verify.ts";

/** One raw request against a real `node:http` server, the way the S-1 malformed-Host probe sends it. */
async function rawExchange(send: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => send(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let received = "";
      socket.on("data", (chunk: Buffer) => (received += chunk.toString("utf8")));
      socket.on("error", reject);
      socket.on("close", () => resolve(received));
      socket.write("GET /x?q=1 HTTP/1.1\r\nhost: evil host!\r\nconnection: close\r\n\r\n");
    });
  } finally {
    server.close();
  }
}

describe("raw HTTP/1.1 response body (S-1 malformed-Host probe)", () => {
  it("de-chunks a chunked body written in several parts", async () => {
    const raw = await rawExchange((response) => {
      response.setHeader("content-type", "application/json");
      response.write('{"origin":');
      response.write('"http://strata.invalid"}');
      response.end();
    });

    assert.match(raw, /transfer-encoding: chunked/i);
    assert.deepEqual(JSON.parse(rawResponseBody(raw)), { origin: "http://strata.invalid" });
  });

  it("returns a fixed-length body unchanged", async () => {
    const raw = await rawExchange((response) => response.end('{"a":"b\\r\\n"}'));

    assert.doesNotMatch(raw, /transfer-encoding/i);
    assert.equal(rawResponseBody(raw), '{"a":"b\\r\\n"}');
  });

  it("returns nothing for a response without a header terminator", () => {
    assert.equal(rawResponseBody("HTTP/1.1 200 OK\r\ncontent-length: 4"), "");
  });
});
