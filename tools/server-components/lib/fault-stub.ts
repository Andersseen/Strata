import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback HTTP stub that serves the full-stack fixture's three public surfaces
 * (`/api/products/:id`, `/api/qualification/:resource`, `/products/:id`) and can be told to misbehave.
 * It exists only for the NEGATIVE CONTROLS of the concurrency matrix: each fault below is a
 * failure the matrix must detect, and `honest` is the positive control that must stay green.
 * It is never reachable from outside the loopback interface and serves no real data.
 *
 *   honest      correct answers
 *   swap        every answer carries the body of the PREVIOUS request (cross-request body exchange)
 *   wrong-cid   the correlation id is not the one the request sent
 *   edge-404    every 7th answer is a Cloudflare-looking HTML 404 (no controller fingerprint)
 *   wrong-404   every 9th /api/products/42|7 answer is the controller's own 404 JSON (wrong status)
 *   drop        every 11th connection is destroyed (transport error)
 */
export type Fault = "honest" | "swap" | "wrong-cid" | "edge-404" | "wrong-404" | "drop";

const CATALOG = new Map([
  ["42", { id: "42", name: "Product 42", available: true }],
  ["7", { id: "7", name: "Product 7", available: false }],
]);
const RESOURCES = new Set(["alpha", "beta", "gamma"]);
const FINGERPRINT = "stub0000";

interface Answer {
  readonly status: number;
  readonly type: string;
  readonly body: string;
  readonly fingerprint: boolean;
}

const json = (status: number, value: unknown, fingerprint = false): Answer => ({
  status,
  type: "application/json",
  body: JSON.stringify(value),
  fingerprint,
});

function honestAnswer(url: URL): Answer {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "api" && parts[1] === "products") {
    const product = CATALOG.get(parts[2] ?? "");

    return product ? json(200, product, true) : json(404, { error: "not_found" });
  }
  if (parts[0] === "api" && parts[1] === "qualification") {
    const name = parts[2] ?? "";

    return RESOURCES.has(name)
      ? json(
          200,
          { resource: name, correlation: url.searchParams.get("cid"), path: url.pathname },
          true,
        )
      : json(404, { error: "not_found" });
  }
  if (parts[0] === "products")
    return {
      status: 200,
      type: "text/html",
      body: `<html><h1>Product ${parts[1] ?? ""}</h1></html>`,
      fingerprint: false,
    };

  return { status: 404, type: "text/html", body: "<html>missing</html>", fingerprint: false };
}

export interface FaultStub {
  readonly baseUrl: string;
  readonly requests: () => number;
  stop(): Promise<void>;
}

export async function startFaultStub(fault: Fault): Promise<FaultStub> {
  let count = 0;
  let previous: Answer | undefined;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const index = ++count;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // Answer a little later than the request, so concurrent requests really interleave.
    const delay = 1 + (index % 5);

    setTimeout(() => {
      if (fault === "drop" && index % 11 === 0) {
        request.socket.destroy();

        return;
      }

      let answer = honestAnswer(url);
      const own = answer;

      if (fault === "swap") answer = previous ?? answer;
      if (
        fault === "wrong-cid" &&
        url.pathname.startsWith("/api/qualification/") &&
        own.status === 200
      )
        answer = json(
          200,
          { resource: url.pathname.split("/")[3], correlation: "someone-else", path: url.pathname },
          true,
        );
      if (fault === "edge-404" && index % 7 === 0)
        answer = {
          status: 404,
          type: "text/html",
          body: "<html>404 Not Found</html>",
          fingerprint: false,
        };
      if (
        fault === "wrong-404" &&
        index % 9 === 0 &&
        /^\/api\/products\/(42|7)$/.test(url.pathname)
      )
        answer = json(404, { error: "not_found" });
      previous = own;

      response.writeHead(answer.status, {
        "content-type": answer.type,
        server: "cloudflare",
        ...(answer.fingerprint ? { "x-fullstack-catalog": FINGERPRINT } : {}),
      });
      response.end(answer.body);
    }, delay);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => count,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
