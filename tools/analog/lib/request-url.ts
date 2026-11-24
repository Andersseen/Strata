import { request as httpRequest } from "node:http";

import type { Report, Runtime } from "./streaming.ts";

/**
 * S-1 on the real fixture (docs/research/pre-rc0-consolidation.md): `request.url` reports the
 * transport URL without `publicOrigin` and exactly the configured origin with it, never reads
 * `X-Forwarded-*`, preserves path and query, and keeps one request's URL to itself.
 *
 * Requests go through `node:http`, not `fetch`, because `Host` is a forbidden header for fetch.
 */

const TRANSPORT = "/api/strata/url/transport";
const PUBLIC = "/api/strata/url/public";
const PUBLIC_ORIGIN = "https://app.strata.test";
const UNKNOWN_ORIGIN = "http://strata.invalid";

interface Echo {
  readonly href: string;
  readonly origin: string;
  readonly path: string;
  readonly search: string;
  readonly query: Record<string, string | string[]>;
}

interface Answer {
  readonly status: number;
  readonly text: string;
}

function send(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const base = new URL(baseUrl);

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        method,
        path,
        headers: { connection: "close", ...headers },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const parse = (answer: Answer): Echo | undefined => {
  try {
    return answer.status === 200 ? (JSON.parse(answer.text) as Echo) : undefined;
  } catch {
    return undefined;
  }
};

export async function observeRequestUrl(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
): Promise<void> {
  const label = `${runtime}: request.url`;
  const host = new URL(baseUrl).host;
  const transportOrigin = `http://${host}`;
  const query = "?b=2&a=1&a=%20x&c=%E2%9C%93";

  // 1. A direct request: the transport URL, path and query exact.
  const direct = parse(await send(baseUrl, "GET", `${TRANSPORT}${query}`, { host }));
  report(
    `${label} of a direct request is the transport URL with the exact path and query`,
    direct?.href === `${transportOrigin}${TRANSPORT}${query}` &&
      direct.search === query &&
      JSON.stringify(direct.query) === JSON.stringify({ b: "2", a: ["1", " x"], c: "✓" }),
    JSON.stringify(direct),
  );

  // 2. Forwarded headers never change it.
  const forwarded = parse(
    await send(baseUrl, "GET", TRANSPORT, {
      host,
      "x-forwarded-host": "attacker.test",
      "x-forwarded-proto": "https",
      forwarded: "host=attacker.test;proto=https",
    }),
  );
  report(
    `${label} ignores X-Forwarded-Host, X-Forwarded-Proto and Forwarded`,
    forwarded?.origin === transportOrigin,
    JSON.stringify(forwarded),
  );

  // 3. Host. Node reports what the client sent, checked. Vite refuses hosts outside
  // `server.allowedHosts` itself; local workerd builds the Worker's request URL from Host, so on
  // every runtime the transport origin is what the client chose, never deployment identity.
  const customAnswer = await send(baseUrl, "GET", TRANSPORT, { host: "Tenant.Example.Test:8443" });
  const malformedAnswer = await send(baseUrl, "GET", TRANSPORT, { host: "evil.test/admin" });
  const custom = parse(customAnswer);
  const malformed = parse(malformedAnswer);
  if (runtime === "dev") {
    report(
      `${label}: Vite refuses a Host outside server.allowedHosts before Nitro runs`,
      customAnswer.status === 403 &&
        malformedAnswer.status === 403 &&
        /Blocked request/.test(customAnswer.text),
      `${String(customAnswer.status)} ${String(malformedAnswer.status)}`,
    );
  } else {
    report(
      `${label} reports a custom Host and port, normalized (transport information, not identity)`,
      custom?.origin === "http://tenant.example.test:8443",
      JSON.stringify(custom),
    );
    // Local workerd folds the Host into the Worker's URL: `evil.test/admin` moves the path to
    // `/admin/api/...`, which no Strata route matches (Nitro answers with the app shell).
    report(
      `${label} never carries a malformed Host: the request misses the Strata route, or gets the reserved unknown origin`,
      runtime === "workerd"
        ? malformed === undefined || malformed.href === `${UNKNOWN_ORIGIN}${TRANSPORT}`
        : malformed?.href === `${UNKNOWN_ORIGIN}${TRANSPORT}`,
      `${String(malformedAnswer.status)} ${malformedAnswer.text.slice(0, 120)}`,
    );
  }

  // 4. publicOrigin is the origin, whatever the request says (a request the runtime itself
  // refuses never reaches Strata).
  const configured = await Promise.all(
    [
      { host },
      { host: "attacker.test", "x-forwarded-host": "attacker.test", "x-forwarded-proto": "http" },
      { host: "evil.test/admin" },
    ].map(async (headers) => send(baseUrl, "GET", `${PUBLIC}${query}`, headers)),
  );
  // A request the runtime refuses or reroutes (see 3) is not an echo; every echo is public.
  const echoes = configured.map(parse);
  report(
    `${label} with publicOrigin is exactly the configured origin, whatever Host and forwarded headers say`,
    echoes[0] !== undefined &&
      echoes[1] !== undefined &&
      echoes.every(
        (echo) => echo === undefined || echo.href === `${PUBLIC_ORIGIN}${PUBLIC}${query}`,
      ),
    configured.map(({ status, text }) => `${String(status)} ${text.slice(0, 120)}`).join(" | "),
  );

  // 5. The consumer's origin check against request.url.origin.
  const submit = (origin: string, extra: Record<string, string> = {}) =>
    send(baseUrl, "POST", `${PUBLIC}/submit`, {
      host,
      origin,
      "content-length": "0",
      ...extra,
    });
  const accepted = await submit(PUBLIC_ORIGIN);
  const placeholder = await submit("http://localhost");
  const local = await submit(transportOrigin);
  const forged = await submit("https://attacker.test", { "x-forwarded-host": "attacker.test" });
  report(
    `${runtime}: a consumer origin check accepts the public origin and refuses localhost, the transport origin and a forged forwarded host`,
    accepted.status === 200 &&
      placeholder.status === 403 &&
      local.status === 403 &&
      forged.status === 403,
    [accepted, placeholder, local, forged].map(({ status }) => status).join(","),
  );

  // 6. Overlapping requests keep their own URL.
  const isolated = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const echo = parse(await send(baseUrl, "GET", `${TRANSPORT}?n=${index}`, { host }));
      return echo?.href === `${transportOrigin}${TRANSPORT}?n=${index}`;
    }),
  );
  report(`${label} stays request-local over 24 overlapping requests`, isolated.every(Boolean));
}
