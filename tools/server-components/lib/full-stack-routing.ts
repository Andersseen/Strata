import {
  expectHead,
  expectJsonNotFound,
  expectMethodNotAllowed,
  expectNativeServed,
  expectNoCors,
  expectOptions,
  JSON_UTF8,
  looksLikeHtml,
  rawRequest,
} from "../../consumer/lib/http-routing.ts";
import type { RoutingReply, Verdict } from "../../consumer/lib/http-routing.ts";

import { PRIVATE_CANARIES, PRODUCT_42 } from "./full-stack-fixture.ts";
import { check } from "./harness.ts";
import { evaluate, openTracked } from "./package-consumer.ts";

/**
 * Black-box HTTP routing and API boundary qualification of the full-stack
 * consumer (docs/research/analog-http-routing-v06.md). It only speaks HTTP, so
 * the SAME checks qualify the Node production server and local workerd.
 *
 * The fixture owns `/api` (`apiBoundary` in its Nitro plugin), declares the
 * native `GET /api/health` route, and keeps `/api/native` and
 * `/api/lifecycle-stats` as native all-method routes.
 */

/** A synthetic secret sent in the query string and a header; it must never be echoed. */
export const ROUTING_QUERY_CANARY = "STRATA_ROUTING_QUERY_CANARY_5d21";
export const ROUTING_HEADER_CANARY = "STRATA_ROUTING_HEADER_CANARY_77ab";

const verdictCheck = (name: string, verdict: Verdict): boolean =>
  check(name, verdict === undefined, verdict ?? "");

export interface RoutingOptions {
  /** `/api/lifecycle-stats` and the request-scoped factory counters (local runs only). */
  readonly lifecycle: boolean;
  /** Server log of a local process; it must not echo the request canaries. */
  readonly log?: () => string;
}

interface Stats {
  readonly created: number;
  readonly cleaned: number;
}

async function readStats(base: string): Promise<Stats> {
  return JSON.parse((await rawRequest(base, "GET", "/api/lifecycle-stats")).body) as Stats;
}

/** The predicates themselves, shown to fail on deliberately wrong replies. */
function negativeControls(): boolean[] {
  const reply = (status: number, body: string, headers: Record<string, string>): RoutingReply => ({
    status,
    body,
    headers: new Headers(headers),
  });
  const html = reply(200, "<!doctype html><title>Analog</title>", { "content-type": "text/html" });
  const json404 = reply(404, '{"error":"not_found"}', {
    "content-type": JSON_UTF8,
    "cache-control": "no-store",
  });
  const cases: [string, Verdict, string][] = [
    ["an owned API path falling through to HTML", expectJsonNotFound(html), "HTML document"],
    [
      "a wrong content type on the 404",
      expectJsonNotFound(
        reply(404, '{"error":"not_found"}', { "content-type": "application/json" }),
      ),
      "content-type",
    ],
    [
      "a 405 for a path that should be 404",
      expectJsonNotFound(
        reply(405, '{"error":"method_not_allowed"}', { "content-type": JSON_UTF8, allow: "GET" }),
      ),
      "status 405",
    ],
    [
      "a wrong Allow set",
      expectMethodNotAllowed(
        reply(405, '{"error":"method_not_allowed"}', {
          "content-type": JSON_UTF8,
          allow: "GET, POST",
        }),
        "GET, HEAD",
      ),
      "wrong Allow",
    ],
    [
      "a native route accidentally shadowed",
      expectNativeServed(json404, { status: "ok" }),
      "shadowed",
    ],
    [
      "HEAD returning a body",
      expectHead(reply(200, "{}", { "content-type": JSON_UTF8 }), "application/json"),
      "returned a body",
    ],
    [
      "OPTIONS unintentionally enabling CORS",
      expectOptions(reply(204, "", { allow: "GET", "access-control-allow-origin": "*" }), "GET"),
      "CORS headers",
    ],
  ];

  return cases.map(([name, verdict, reason]) =>
    check(
      `negative control: ${name} is detected for its own reason`,
      verdict !== undefined && verdict.includes(reason),
      String(verdict),
    ),
  );
}

export async function routingSuite(
  base: string,
  label: string,
  options: RoutingOptions,
): Promise<boolean[]> {
  const ok: boolean[] = [...negativeControls()];
  const send = (method: string, path: string, headers?: Record<string, string>) =>
    rawRequest(base, method, path, headers);
  const everything: RoutingReply[] = [];
  const track = async (reply: Promise<RoutingReply>): Promise<RoutingReply> => {
    const value = await reply;

    everything.push(value);

    return value;
  };
  const statsBefore = options.lifecycle ? await readStats(base) : undefined;

  // --- 404: owned namespace ------------------------------------------------
  for (const path of [
    "/api/nonexistent",
    `/api/products/42/unknown-route?token=${ROUTING_QUERY_CANARY}`,
    "/api",
    "/api/",
    "/api/products//42",
    "/api/Products/42",
    "/api/products/%C3%A9/extra",
  ]) {
    ok.push(
      verdictCheck(
        `${label}: GET ${path.split("?")[0]} → JSON 404, no HTML shell, nothing echoed`,
        expectJsonNotFound(
          await track(send("GET", path, { "x-routing-canary": ROUTING_HEADER_CANARY })),
        ),
      ),
    );
  }

  // --- 405 and Allow -------------------------------------------------------
  const productAllow = "GET, HEAD, OPTIONS";

  for (const method of ["PUT", "PATCH", "DELETE", "POST", "TRACE", "PROPFIND"]) {
    ok.push(
      verdictCheck(
        `${label}: ${method} /api/products/42 → 405 with Allow: ${productAllow}`,
        expectMethodNotAllowed(await track(send(method, "/api/products/42?x=1")), productAllow),
      ),
    );
  }
  ok.push(
    verdictCheck(
      `${label}: DELETE /api/products/42/extra → 404, not a 405 for a path no route matches`,
      expectJsonNotFound(await track(send("DELETE", "/api/products/42/extra"))),
    ),
    check(
      `${label}: an unknown resource id still reaches its matched handler (app-level 404, not a boundary 405)`,
      await send("GET", "/api/products/not-a-route").then((reply) => {
        everything.push(reply);

        return reply.status === 404 && reply.headers.get("allow") === null;
      }),
    ),
  );

  // --- HEAD ---------------------------------------------------------------
  const headBefore = options.lifecycle ? await readStats(base) : undefined;
  const head = await track(send("HEAD", "/api/products/42"));

  ok.push(
    verdictCheck(
      `${label}: HEAD /api/products/42 → 200, headers, no body`,
      expectHead(head, "application/json"),
    ),
    check(
      `${label}: HEAD carries the GET route's own headers (catalog fingerprint, no-store)`,
      !!head.headers.get("x-fullstack-catalog") && head.headers.get("cache-control") === "no-store",
    ),
  );
  if (headBefore) {
    const headAfter = await readStats(base);

    ok.push(
      check(
        `${label}: HEAD ran the GET pipeline exactly once and cleaned up once`,
        headAfter.created - headBefore.created === 1 &&
          headAfter.cleaned - headBefore.cleaned === 1,
        JSON.stringify({ headBefore, headAfter }),
      ),
    );
  }
  ok.push(
    verdictCheck(
      `${label}: HEAD /api/nonexistent → 404`,
      (({ status, headers, body }) =>
        status === 404 && headers.get("content-type") === JSON_UTF8 && body === ""
          ? undefined
          : `${status} ${headers.get("content-type")} body=${body.length}`)(
        await track(send("HEAD", "/api/nonexistent")),
      ),
    ),
  );

  // --- OPTIONS ------------------------------------------------------------
  ok.push(
    verdictCheck(
      `${label}: OPTIONS /api/products/42 → 204 + Allow, no CORS headers`,
      expectOptions(await track(send("OPTIONS", "/api/products/42")), productAllow),
    ),
  );

  const preflight = await track(
    send("OPTIONS", "/api/products/42", {
      origin: "https://evil.example",
      "access-control-request-method": "DELETE",
    }),
  );

  ok.push(
    verdictCheck(
      `${label}: OPTIONS preflight → 405 with Allow: GET, HEAD and no access-control-* header`,
      expectMethodNotAllowed(preflight, "GET, HEAD") ?? expectNoCors(preflight),
    ),
    verdictCheck(
      `${label}: OPTIONS /api/nonexistent → 404`,
      expectJsonNotFound(await track(send("OPTIONS", "/api/nonexistent"))),
    ),
  );

  // --- native Nitro routes ------------------------------------------------
  ok.push(
    verdictCheck(
      `${label}: native GET /api/health is served by Nitro, not shadowed`,
      expectNativeServed(await track(send("GET", "/api/health")), {
        status: "ok",
        source: "nitro",
      }),
    ),
    verdictCheck(
      `${label}: native /api/native (all methods) still answers POST`,
      expectNativeServed(await track(send("POST", "/api/native")), { source: "analog" }),
    ),
    verdictCheck(
      `${label}: POST /api/health (declared native GET) → 405 Allow: GET, OPTIONS`,
      expectMethodNotAllowed(await track(send("POST", "/api/health")), "GET, OPTIONS"),
    ),
  );

  // --- guards stay on matched routes only ---------------------------------
  ok.push(
    check(
      `${label}: a matched protected route still enforces its guard (DELETE → 401, no token)`,
      await send("DELETE", "/api/guarded-products/ada-item").then((reply) => {
        everything.push(reply);

        return reply.status === 401;
      }),
    ),
    check(
      `${label}: owner DELETE passes the guard and reaches the handler`,
      await send("DELETE", "/api/guarded-products/ada-item", {
        authorization: "Bearer opaque-ada",
      }).then((reply) => {
        everything.push(reply);

        return reply.status === 200;
      }),
    ),
    verdictCheck(
      `${label}: PUT /api/guarded-products/ada-item → 405 (no guard applies to an unmatched method)`,
      expectMethodNotAllowed(
        await track(send("PUT", "/api/guarded-products/ada-item")),
        "GET, HEAD, DELETE, OPTIONS",
      ),
    ),
    verdictCheck(
      `${label}: DELETE /api/guarded-products → 405 Allow: POST, OPTIONS`,
      expectMethodNotAllowed(await track(send("DELETE", "/api/guarded-products")), "POST, OPTIONS"),
    ),
  );

  // --- coexistence: pages, assets -----------------------------------------
  const page = await track(send("GET", "/products/42"));
  const about = await track(send("GET", "/about"));
  const lookalike = await track(send("GET", "/apix"));
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
  const assetReply = asset ? await track(send("GET", asset)) : undefined;

  ok.push(
    check(
      `${label}: Analog SSR pages stay HTML (/products/42, /about, /apix)`,
      [page, about, lookalike].every(
        (reply) =>
          reply.status === 200 && (reply.headers.get("content-type") ?? "").includes("text/html"),
      ),
      [page, about, lookalike].map((reply) => reply.status).join(","),
    ),
    check(
      `${label}: a static client asset is not intercepted by the API boundary`,
      assetReply !== undefined &&
        assetReply.status === 200 &&
        (assetReply.headers.get("content-type") ?? "").includes("javascript"),
      `${asset} ${assetReply?.status} ${assetReply?.headers.get("content-type")}`,
    ),
  );

  // --- path encoding ------------------------------------------------------
  const encoded = await track(send("GET", "/api/products/%34%32"));
  const trailing = await track(send("GET", "/api/products/42/"));
  const malformed = await track(send("GET", "/api/products/%E0%A4%A"));

  ok.push(
    check(
      `${label}: percent-encoded and trailing-slash ids follow Nitro (%34%32 → 42, 42/ → 42)`,
      [encoded, trailing].every(
        (reply) =>
          reply.status === 200 &&
          JSON.stringify(JSON.parse(reply.body)) === JSON.stringify(PRODUCT_42),
      ),
      `${encoded.status} ${trailing.status}`,
    ),
    check(
      `${label}: malformed percent-encoding never produces an HTML document or echoes the path`,
      !looksLikeHtml(malformed) && !malformed.body.includes("%E0%A4%A"),
      `${malformed.status} ${malformed.body.slice(0, 80)}`,
    ),
  );

  // --- overlap: 24+ concurrent requests behind one gate --------------------
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated = <T>(run: () => Promise<T>): Promise<T> => gate.then(run);
  const plan: {
    name: string;
    run: () => Promise<RoutingReply>;
    verdict: (r: RoutingReply) => Verdict;
  }[] = [];

  for (let index = 0; index < 4; index += 1) {
    plan.push(
      {
        name: "matched public GET",
        run: () => send("GET", "/api/products/42"),
        verdict: (reply) =>
          reply.status === 200 && reply.body === JSON.stringify(PRODUCT_42)
            ? undefined
            : `${reply.status} ${reply.body}`,
      },
      {
        name: "unknown API path",
        run: () => send("GET", `/api/unknown-${index}?q=${ROUTING_QUERY_CANARY}`),
        verdict: expectJsonNotFound,
      },
      {
        name: "unsupported method",
        run: () => send("PUT", "/api/products/42"),
        verdict: (reply) => expectMethodNotAllowed(reply, productAllow),
      },
      {
        name: "native route",
        run: () => send("GET", "/api/health"),
        verdict: (reply) => expectNativeServed(reply, { status: "ok", source: "nitro" }),
      },
      {
        name: "protected route, no token",
        run: () => send("DELETE", "/api/guarded-products/grace-item"),
        verdict: (reply) => (reply.status === 401 ? undefined : `status ${reply.status}`),
      },
      {
        name: "protected route, wrong owner",
        run: () =>
          send("DELETE", "/api/guarded-products/grace-item", {
            authorization: "Bearer opaque-ada",
          }),
        verdict: (reply) => (reply.status === 403 ? undefined : `status ${reply.status}`),
      },
      {
        name: "HEAD derived from GET",
        run: () => send("HEAD", "/api/products/42"),
        verdict: (reply) => expectHead(reply, "application/json"),
      },
      {
        name: "plain OPTIONS",
        run: () => send("OPTIONS", "/api/products/42"),
        verdict: (reply) => expectOptions(reply, productAllow),
      },
    );
  }

  const pending = plan.map((entry) => gated(entry.run));

  release();

  const settled = await Promise.all(pending);
  const failures = settled.flatMap((reply, index) => {
    everything.push(reply);

    const entry = plan[index];
    const verdict = entry?.verdict(reply);

    return verdict === undefined ? [] : [`${entry?.name}: ${verdict}`];
  });

  ok.push(
    check(
      `${label}: ${plan.length} overlapping requests behind one gate each get exactly their own answer`,
      plan.length >= 24 && failures.length === 0,
      failures.slice(0, 3).join(" | "),
    ),
  );

  if (statsBefore) {
    const statsAfter = await readStats(base);

    ok.push(
      check(
        `${label}: every controller instance the routing requests created was cleaned up exactly once`,
        statsAfter.created - statsBefore.created === statsAfter.cleaned - statsBefore.cleaned &&
          statsAfter.created > statsBefore.created,
        JSON.stringify({ statsBefore, statsAfter }),
      ),
    );
  }

  // --- confidentiality ----------------------------------------------------
  const surface = everything
    .map((reply) => `${reply.body}\n${[...reply.headers].join(";")}`)
    .join("\n");

  ok.push(
    check(
      `${label}: no routing answer echoes the query/header canary or any private canary`,
      !surface.includes(ROUTING_QUERY_CANARY) &&
        !surface.includes(ROUTING_HEADER_CANARY) &&
        PRIVATE_CANARIES.every((canary) => !surface.includes(canary)),
    ),
  );
  if (options.log) {
    ok.push(
      check(
        `${label}: the server log does not echo the request canaries`,
        !options.log().includes(ROUTING_QUERY_CANARY),
      ),
    );
  }

  return ok;
}

/**
 * The hydrated Server Component island probes the API (found, unknown route,
 * unsupported method) from the browser: every answer must be JSON, never an
 * accidental HTML document, and hydration must not fail because of one.
 */
export async function routingBrowserSuite(base: string, label: string): Promise<boolean[]> {
  const tracked = await openTracked();
  const { page } = tracked;

  try {
    await page.goto(`${base}/products/42`, { waitUntil: "load" });
    await page.waitForSelector("product-availability[data-strata-hydrated]", { timeout: 15_000 });
    await page.click("[data-api-probe]");
    await page.waitForFunction(
      "document.querySelector('[data-api-probe-result]')?.textContent?.startsWith('API: found=')",
      undefined,
      { timeout: 15_000 },
    );

    const result = await evaluate<string>(
      page,
      "document.querySelector('[data-api-probe-result]').textContent",
    );
    const unexpected = tracked.errors.filter(
      (error) =>
        !/Failed to load resource: the server responded with a status of (404|405)/.test(error),
    );

    return [
      check(
        `${label}: browser sees valid JSON data, a JSON 404 for an unknown route, and a JSON 405 with Allow`,
        result ===
          "API: found=200 json data; missing=404 json data; unsupported=405 json data allow=GET, HEAD, OPTIONS",
        result,
      ),
      check(
        `${label}: no HTML document was returned to an API call and hydration did not fail`,
        !result.includes("html") && !result.includes("NOT-JSON") && unexpected.length === 0,
        unexpected.join(" | "),
      ),
    ];
  } finally {
    await tracked.close();
  }
}
