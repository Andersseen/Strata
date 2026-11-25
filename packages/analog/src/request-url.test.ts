import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createServer as createTlsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Controller, Get, Post } from "@strata-sc/core";
import { createApp, createRouter, eventHandler, toNodeListener, toWebHandler } from "h3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { StrataAnalogConfigurationError } from "./errors.js";
import { registerControllers } from "./register-controllers.js";
import type {
  RegisterControllersOptions,
  StrataAnalogGuard,
  StrataAnalogRequest,
} from "./register-controllers.js";
import { resolveRequestUrl, UNKNOWN_ORIGIN } from "./request-url.js";

/**
 * S-1 (docs/research/pre-rc0-consolidation.md): what `request.url` may be trusted for.
 *
 * Real `node:http` and `node:https` servers with H3 v1's `toNodeListener`, the listener Nitro's
 * node-server preset mounts, and raw sockets where a request must say something no HTTP client
 * would send. The Analog fixture repeats the runtime-facing checks on the production Nitro build,
 * the Vite dev server and local workerd (`pnpm test:analog-headers`).
 */

@Controller("/url")
class UrlController {
  @Get("/")
  echo(request: StrataAnalogRequest) {
    return {
      href: request.url.href,
      origin: request.url.origin,
      path: request.path,
      search: request.url.search,
      query: request.query,
    };
  }

  @Post("/submit")
  submit() {
    return { accepted: true };
  }
}

/** A consumer's origin check, as the RC0 report's consumer (ForgeCMS) wrote it. */
const sameOrigin: StrataAnalogGuard = ({ request }) =>
  request.method !== "POST" || request.headers.get("origin") === request.url.origin
    ? { allow: true }
    : { allow: false, status: 403 };

function application(options: RegisterControllersOptions = {}) {
  const app = createApp();
  const router = createRouter({ preemptive: true });

  app.use(router.handler);
  registerControllers(router, [UrlController], { guards: [sameOrigin], ...options });

  return app;
}

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** Sends exactly these bytes and returns the parsed JSON body of the response. */
function raw(port: number, head: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1]);
      const text = data.slice(data.indexOf("\r\n\r\n") + 4);
      try {
        resolve({ status, body: JSON.parse(text) as unknown });
      } catch {
        resolve({ status, body: text });
      }
    });
    socket.write(`${head}\r\nconnection: close\r\n\r\n`);
  });
}

interface Echo {
  readonly href: string;
  readonly origin: string;
  readonly path: string;
  readonly search: string;
  readonly query: Record<string, string | string[]>;
}

const echo = async (port: number, target: string, ...headers: string[]): Promise<Echo> => {
  const response = await raw(port, [`GET ${target} HTTP/1.1`, ...headers].join("\r\n"));
  expect(response.status).toBe(200);
  return response.body as Echo;
};

describe("request.url on Nitro's Node listener, without publicOrigin", () => {
  it("reports the Host the client sent, with the socket's scheme, for a direct request", async () => {
    const port = await listen(createServer(toNodeListener(application())));
    const response = await fetch(`http://127.0.0.1:${port}/url?a=1`);

    expect(await response.json()).toMatchObject({
      href: `http://127.0.0.1:${port}/url?a=1`,
      origin: `http://127.0.0.1:${port}`,
    });
  });

  it("keeps a custom host and port, normalized, and drops the default port", async () => {
    const port = await listen(createServer(toNodeListener(application())));

    expect((await echo(port, "/url", "host: App.Example.Test:8443")).origin).toBe(
      "http://app.example.test:8443",
    );
    expect((await echo(port, "/url", "host: app.example.test:80")).origin).toBe(
      "http://app.example.test",
    );
    expect((await echo(port, "/url", "host: [::1]:3000")).origin).toBe("http://[::1]:3000");
  });

  it("never reads X-Forwarded-Host or X-Forwarded-Proto", async () => {
    const port = await listen(createServer(toNodeListener(application())));
    const url = await echo(
      port,
      "/url",
      "host: internal.test:3000",
      "x-forwarded-host: attacker.test",
      "x-forwarded-proto: https",
      "forwarded: host=attacker.test;proto=https",
    );

    expect(url.origin).toBe("http://internal.test:3000");
  });

  it.each([
    ["a path", "host: evil.test/admin"],
    ["credentials", "host: user@evil.test"],
    ["a query", "host: evil.test?x"],
    ["a fragment", "host: evil.test#x"],
    ["whitespace", "host: evil test"],
    ["a backslash", "host: evil.test\\x"],
    ["an empty value", "host: "],
    ["an out-of-range port", "host: evil.test:99999"],
    ["an unclosed IPv6 literal", "host: [::1"],
    ["a leading dot", "host: .evil.test"],
  ])("answers the reserved unknown origin for a Host with %s", async (_, header) => {
    const port = await listen(createServer(toNodeListener(application())));
    const url = await echo(port, "/url?keep=1", header);

    expect(url.origin).toBe(UNKNOWN_ORIGIN);
    expect(url.href).toBe(`${UNKNOWN_ORIGIN}/url?keep=1`);
  });

  it("answers the reserved unknown origin, never localhost, when there is no Host", async () => {
    const port = await listen(createServer(toNodeListener(application())));
    const response = await raw(port, "GET /url HTTP/1.0");

    expect(response.status).toBe(200);
    expect((response.body as Echo).origin).toBe(UNKNOWN_ORIGIN);
  });

  it("never lets an absolute-form or scheme-relative target choose the origin", async () => {
    const port = await listen(createServer(toNodeListener(application())));

    // H3 v1 routes on the raw target, so neither form reaches a Strata route on Node...
    for (const target of ["http://attacker.test/url?x=1", "//attacker.test/url"]) {
      expect((await raw(port, `GET ${target} HTTP/1.1\r\nhost: app.test`)).status).toBe(404);
    }

    // ...and if a runtime did route one, only its path and query would be kept.
    const event = (path: string) => ({ path, node: { req: { headers: { host: "app.test" } } } });
    expect(resolveRequestUrl(event("http://attacker.test/url?x=1#f"), undefined).href).toBe(
      "http://app.test/url?x=1",
    );
    expect(resolveRequestUrl(event("//attacker.test/url"), undefined).href).toBe(
      "http://app.test//attacker.test/url",
    );
    expect(resolveRequestUrl(event("/\\attacker.test/url"), undefined).origin).toBe(
      "http://app.test",
    );
    expect(resolveRequestUrl(event("*"), "https://app.example.test").href).toBe(
      "https://app.example.test/*",
    );
  });

  it("preserves the query string exactly, repeated and encoded values included", async () => {
    const port = await listen(createServer(toNodeListener(application())));
    const url = await echo(port, "/url?b=2&a=1&a=%20x&c=%E2%9C%93&empty=", "host: app.test");

    expect(url.search).toBe("?b=2&a=1&a=%20x&c=%E2%9C%93&empty=");
    expect(url.query).toEqual({ b: "2", a: ["1", " x"], c: "✓", empty: "" });
    expect(url.path).toBe("/url");
  });

  it("keeps the URL request-local under concurrency", async () => {
    const port = await listen(createServer(toNodeListener(application())));
    const results = await Promise.all(
      Array.from({ length: 48 }, async (_, index) => {
        const url = await echo(port, `/url?n=${index}`, `host: tenant-${index}.test`);
        return url.href === `http://tenant-${index}.test/url?n=${index}`;
      }),
    );

    expect(results.every(Boolean)).toBe(true);
  });
});

describe("request.url over TLS", () => {
  let dir: string;
  let key: Buffer;
  let cert: Buffer;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-url-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "pipe" },
    );
    key = readFileSync(join(dir, "key.pem"));
    cert = readFileSync(join(dir, "cert.pem"));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const get = (port: number, headers: Record<string, string>) =>
    new Promise<Echo>((resolve, reject) => {
      const request = httpsRequest(
        { host: "127.0.0.1", port, path: "/url", headers, rejectUnauthorized: false },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.on("end", () => resolve(JSON.parse(text) as Echo));
        },
      );
      request.on("error", reject);
      request.end();
    });

  it("reports https from the TLS socket itself, and ignores a forwarded downgrade", async () => {
    const port = await listen(createTlsServer({ key, cert }, toNodeListener(application())));

    expect(
      (await get(port, { host: `localhost:${port}`, "x-forwarded-proto": "http" })).origin,
    ).toBe(`https://localhost:${port}`);
  });

  it("reports http behind a TLS-terminating proxy unless publicOrigin says otherwise", async () => {
    const port = await listen(createServer(toNodeListener(application())));

    expect((await echo(port, "/url", "host: app.test", "x-forwarded-proto: https")).origin).toBe(
      "http://app.test",
    );
  });
});

describe("publicOrigin", () => {
  const PUBLIC = "https://app.example.test";

  it("is the origin of every request.url, whatever Host and forwarded headers say", async () => {
    const port = await listen(createServer(toNodeListener(application({ publicOrigin: PUBLIC }))));

    for (const headers of [
      ["host: internal:3000"],
      ["host: attacker.test", "x-forwarded-host: attacker.test", "x-forwarded-proto: http"],
      ["host: evil.test/admin"],
    ]) {
      const url = await echo(port, "/url?a=1&a=2", ...headers);
      expect(url.href).toBe(`${PUBLIC}/url?a=1&a=2`);
    }

    expect((await raw(port, "GET /url HTTP/1.0")).body).toMatchObject({ origin: PUBLIC });
    expect(
      resolveRequestUrl(
        { path: "http://attacker.test/url", web: { url: new URL("http://x/") } },
        PUBLIC,
      ).href,
    ).toBe(`${PUBLIC}/url`);
  });

  it("also replaces the origin a web runtime reports", async () => {
    const handle = toWebHandler(application({ publicOrigin: `${PUBLIC}/` }));
    const response = await handle(new Request("http://10.0.0.7:8787/url?q=1"));

    expect(await response.json()).toMatchObject({ href: `${PUBLIC}/url?q=1`, origin: PUBLIC });
  });

  it.each([
    ["a relative value", "/app"],
    ["a non-http scheme", "ftp://app.example.test"],
    ["a path", "https://app.example.test/app"],
    ["a query", "https://app.example.test?x=1"],
    ["a fragment", "https://app.example.test#x"],
    ["credentials", "https://user:pass@app.example.test"],
    ["an empty string", ""],
    ["a non-string", 443],
  ])("refuses %s at registration, before touching the router", (_, value) => {
    const router = createRouter();
    const added: string[] = [];
    const recording = {
      add: (path: string, handler: Parameters<typeof router.add>[1], method: "get") => {
        added.push(path);
        return router.add(path, handler, method);
      },
    };

    expect(() =>
      registerControllers(recording, [UrlController], {
        publicOrigin: value as unknown as string,
      }),
    ).toThrow(StrataAnalogConfigurationError);
    expect(added).toEqual([]);
  });
});

describe("runtimes that report the URL they received", () => {
  it("uses the web adapter's request URL", async () => {
    const response = await toWebHandler(application())(
      new Request("https://pages.example.test/url?x=%2F"),
    );

    expect(await response.json()).toMatchObject({
      href: "https://pages.example.test/url?x=%2F",
      query: { x: "/" },
    });
  });

  it("uses the Request Nitro's Cloudflare presets put in event.context.cloudflare", async () => {
    // Nitro's Cloudflare entries call H3 through a mock Node request whose socket reports `http`
    // (it compares `protocol === "https"` with `url.protocol`, which is "https:"). The Request the
    // Worker received is what carries the real scheme; local workerd is covered by the fixture.
    const app = application();
    const outer = createApp();
    outer.use(
      eventHandler((event) => {
        event.context["cloudflare"] = { request: new Request("https://app.pages.dev/url?x=1") };
      }),
    );
    outer.use(app);
    const port = await listen(createServer(toNodeListener(outer)));

    expect((await echo(port, "/url?x=1", "host: app.pages.dev")).href).toBe(
      "https://app.pages.dev/url?x=1",
    );
  });
});

describe("a consumer origin check against request.url.origin", () => {
  const post = (port: number, ...headers: string[]) =>
    raw(port, [`POST /url/submit HTTP/1.1`, "content-length: 0", ...headers].join("\r\n"));

  it("accepts the real origin and refuses forgeries when publicOrigin is configured", async () => {
    const port = await listen(
      createServer(toNodeListener(application({ publicOrigin: "https://app.example.test" }))),
    );

    expect(
      (await post(port, "host: internal:3000", "origin: https://app.example.test")).status,
    ).toBe(200);
    // The placeholder that S-1 reported a consumer could be tricked into accepting.
    expect((await post(port, "host: internal:3000", "origin: http://localhost")).status).toBe(403);
    expect(
      (
        await post(
          port,
          "host: attacker.test",
          "x-forwarded-host: attacker.test",
          "origin: https://attacker.test",
        )
      ).status,
    ).toBe(403);
  });

  it("fails closed without publicOrigin when the origin cannot be determined", async () => {
    const port = await listen(createServer(toNodeListener(application())));

    expect((await post(port, "host: evil.test/x", "origin: http://localhost")).status).toBe(403);
    expect((await post(port, "host: app.test", "origin: https://app.test")).status).toBe(403);
  });
});
