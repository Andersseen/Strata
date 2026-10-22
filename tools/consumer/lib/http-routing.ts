/**
 * Shared, dependency-free HTTP assertions for the routing and API boundary contract
 * (docs/research/analog-http-routing-v06.md). Every `expect*` returns `undefined`
 * when satisfied, otherwise the reason it is not, so a negative control can prove
 * each one fails for its own reason.
 */
import { request as nodeRequest } from "node:http";

export interface RoutingReply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * Any method, including the ones `fetch` refuses (TRACE): `node:http` sends
 * exactly the request line it is given.
 */
export function rawRequest(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<RoutingReply> {
  const url = new URL(base);

  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      { host: url.hostname, port: url.port, method, path, headers, timeout: 30_000 },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseHeaders = new Headers();

          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end();
  });
}

export const JSON_UTF8 = "application/json; charset=utf-8";

export const looksLikeHtml = (reply: RoutingReply): boolean =>
  (reply.headers.get("content-type") ?? "").includes("text/html") ||
  /^\s*<(!doctype|html)/i.test(reply.body);

export type Verdict = string | undefined;

export function expectJsonNotFound(reply: RoutingReply): Verdict {
  if (looksLikeHtml(reply)) return "answered with an HTML document";
  if (reply.status !== 404) return `status ${reply.status}, expected 404`;
  if (reply.headers.get("content-type") !== JSON_UTF8) {
    return `content-type ${reply.headers.get("content-type")}`;
  }
  if (reply.headers.get("cache-control") !== "no-store") return "missing cache-control: no-store";
  if (reply.body !== '{"error":"not_found"}') return `body ${reply.body.slice(0, 80)}`;

  return undefined;
}

export function expectMethodNotAllowed(reply: RoutingReply, allow: string): Verdict {
  if (looksLikeHtml(reply)) return "answered with an HTML document";
  if (reply.status !== 405) return `status ${reply.status}, expected 405`;
  if (reply.headers.get("allow") !== allow) {
    return `wrong Allow: ${reply.headers.get("allow")}, expected ${allow}`;
  }
  if (reply.headers.get("content-type") !== JSON_UTF8) {
    return `content-type ${reply.headers.get("content-type")}`;
  }
  if (reply.body !== '{"error":"method_not_allowed"}') return `body ${reply.body.slice(0, 80)}`;

  return undefined;
}

export function expectHead(reply: RoutingReply, contentType: string): Verdict {
  if (reply.status !== 200) return `status ${reply.status}, expected 200`;
  if (reply.body !== "") return `HEAD returned a body (${reply.body.length} chars)`;
  if (!reply.headers.get("content-type")?.startsWith(contentType)) {
    return `content-type ${reply.headers.get("content-type")}`;
  }

  return undefined;
}

export function expectOptions(reply: RoutingReply, allow: string): Verdict {
  if (reply.status !== 204) return `status ${reply.status}, expected 204`;
  if (reply.headers.get("allow") !== allow) {
    return `wrong Allow: ${reply.headers.get("allow")}, expected ${allow}`;
  }

  return expectNoCors(reply);
}

export function expectNoCors(reply: RoutingReply): Verdict {
  const cors = [...reply.headers.keys()].filter((name) => name.startsWith("access-control-"));

  return cors.length === 0 ? undefined : `CORS headers present: ${cors.join(", ")}`;
}

export function expectNativeServed(reply: RoutingReply, expected: unknown): Verdict {
  if (reply.status !== 200) return `native route shadowed: status ${reply.status}`;

  // Dev servers pretty-print JSON; compare the value, not the bytes.
  let actual: unknown;

  try {
    actual = JSON.parse(reply.body);
  } catch {
    return `native route shadowed: ${reply.body.slice(0, 80)}`;
  }

  return JSON.stringify(actual) === JSON.stringify(expected)
    ? undefined
    : `native route shadowed: ${reply.body.slice(0, 80)}`;
}

/** A 405 answered to a `HEAD` request: status and `Allow` only, never a body. */
export function expectHeadMethodNotAllowed(reply: RoutingReply, allow: string): Verdict {
  if (reply.status !== 405) return `status ${reply.status}, expected 405`;
  if (reply.headers.get("allow") !== allow) {
    return `wrong Allow: ${reply.headers.get("allow")}, expected ${allow}`;
  }

  return reply.body === "" ? undefined : `HEAD returned a body (${reply.body.length} chars)`;
}
