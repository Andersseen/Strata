import { stripVTControlCharacters } from "node:util";

import {
  CONTROLLER_FINGERPRINT,
  EXPECTED_EVIDENCE,
  FULL_STACK_MARKERS,
  PRIVATE_CANARIES,
  PRODUCT_42,
} from "./full-stack-fixture.ts";
import { check } from "./harness.ts";
import { evaluate, openTracked } from "./package-consumer.ts";
import type { Tracked } from "./package-consumer.ts";

/**
 * The black-box verification of the full-stack consumer (controller API, native
 * route, Server Component SSR, hydrated island, document navigation). It only
 * speaks HTTP and drives Chromium, so the SAME checks qualify a local Node
 * server, local workerd and a public Cloudflare Pages URL; the runners decide
 * what the result may be called (full-stack-consumer.ts, full-stack-deployed-cloudflare.ts).
 */

const sanitize = (text: string): string => stripVTControlCharacters(text);

export const hasCanary = (text: string): string[] =>
  PRIVATE_CANARIES.filter((c) => text.includes(c));

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

export async function get(url: string): Promise<Reply> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

  return { status: response.status, headers: response.headers, body: await response.text() };
}

export const json = <T>(reply: Reply): T => JSON.parse(reply.body) as T;

/**
 * HTTP qualification of a running build (Node or workerd): controller API,
 * native Nitro route, request-scoped lifecycle and the Server Component page.
 */
export interface HttpOptions {
  /**
   * The request-scoped lifecycle probes need the fixture's `/api/lifecycle-stats`
   * counter, which is deliberately not something to depend on over a public
   * deployment (isolates are reused or replaced): local runs only.
   */
  readonly lifecycle: boolean;
  /** Server log of a local process, scanned for JIT fallbacks and errors. Absent for a remote URL. */
  readonly log?: () => string;
}

export interface HttpResult {
  /** Strata controller + native Nitro route. */
  readonly controller: boolean[];
  /** Server Component SSR page and the server log. */
  readonly serverComponents: boolean[];
}

export async function httpSuite(
  base: string,
  label: string,
  options: HttpOptions,
): Promise<HttpResult> {
  const ok: boolean[] = [];

  const product = await get(`${base}/api/products/42`);

  ok.push(
    check(
      `${label}: GET /api/products/42 → 200 JSON from the Strata controller`,
      product.status === 200 &&
        !!product.headers.get("content-type")?.includes("application/json") &&
        JSON.stringify(json(product)) === JSON.stringify(PRODUCT_42),
      `${product.status} ${product.body}`,
    ),
    check(
      `${label}: the controller really ran (catalog fingerprint header, no-store)`,
      product.headers.get("x-fullstack-catalog") === CONTROLLER_FINGERPRINT &&
        product.headers.get("cache-control") === "no-store",
      String(product.headers.get("x-fullstack-catalog")),
    ),
    check(
      `${label}: the public API JSON and headers carry no private canary`,
      hasCanary(`${product.body}${[...product.headers].join(";")}`).length === 0,
    ),
  );

  const contractError = await get(`${base}/api/application-contract/missing`);
  ok.push(
    check(
      `${label}: packed application errors produce redacted 404/no-store JSON`,
      contractError.status === 404 &&
        contractError.body === '{"error":"not_found"}' &&
        contractError.headers.get("cache-control") === "no-store" &&
        !contractError.body.includes("canary"),
      `${contractError.status} ${contractError.body}`,
    ),
  );

  const contractCreated = await fetch(`${base}/api/application-contract/created`, {
    method: "POST",
  });
  const contractCookies = contractCreated.headers.getSetCookie();
  const contractCreatedBody = await contractCreated.text();
  ok.push(
    check(
      `${label}: packed JSON helper keeps 201, consumer cache policy and separate cookies`,
      contractCreated.status === 201 &&
        contractCreatedBody === '{"id":"packed-product"}' &&
        contractCreated.headers.get("content-type") === "application/json; charset=utf-8" &&
        contractCreated.headers.get("cache-control") === "private, max-age=15" &&
        contractCookies.length === 2,
      `${contractCreated.status} ${contractCreated.headers.get("cache-control")} cookies=${contractCookies.length}`,
    ),
  );

  const contractInvalid = await fetch(`${base}/api/application-contract/invalid-state`, {
    method: "PATCH",
  });
  ok.push(
    check(
      `${label}: packed application errors support 422 without message exposure`,
      contractInvalid.status === 422 &&
        (await contractInvalid.text()) === '{"error":"invalid_product_state"}',
      `${contractInvalid.status}`,
    ),
  );

  const contractDeleted = await fetch(`${base}/api/application-contract/deleted`, {
    method: "DELETE",
  });
  ok.push(
    check(
      `${label}: packed noContent helper is an empty 204 with caller headers`,
      contractDeleted.status === 204 &&
        (await contractDeleted.text()) === "" &&
        contractDeleted.headers.get("content-type") === null &&
        contractDeleted.headers.get("x-deleted") === "packed-product",
      `${contractDeleted.status}`,
    ),
  );

  const seven = await get(`${base}/api/products/7`);

  ok.push(
    check(
      `${label}: path parameter selects the resource (/api/products/7 → unavailable)`,
      seven.status === 200 && json<{ id: string; available: boolean }>(seven).available === false,
      seven.body,
    ),
  );

  const guardCases = await Promise.all([
    fetch(`${base}/api/guarded-products`, { method: "POST" }),
    fetch(`${base}/api/guarded-products`, {
      method: "POST",
      headers: { authorization: "Bearer invalid-canary" },
    }),
    fetch(`${base}/api/guarded-products/ada-item`, {
      method: "DELETE",
      headers: { authorization: "Bearer opaque-ada" },
    }),
    fetch(`${base}/api/guarded-products/grace-item`, {
      method: "DELETE",
      headers: { authorization: "Bearer opaque-ada" },
    }),
    fetch(`${base}/api/guarded-products/public-item`),
    ...Array.from({ length: 24 }, (_, index) => {
      const kind = index % 4;
      return fetch(
        `${base}/api/guarded-products${kind === 0 ? "" : `/${kind === 3 ? "grace-item" : "ada-item"}`}`,
        {
          method: kind === 0 ? "POST" : kind === 1 || kind === 3 ? "DELETE" : "GET",
          ...(kind === 0
            ? {}
            : {
                headers: {
                  authorization: kind === 2 ? "Bearer opaque-grace" : "Bearer opaque-ada",
                },
              }),
        },
      );
    }),
  ]);
  const guardTexts = await Promise.all(guardCases.map((response) => response.text()));
  const guardStatuses = guardCases.map((response) => response.status);
  ok.push(
    check(
      `${label}: request guards return safe 401/403, allow public/owner requests, and isolate 24 overlaps`,
      guardStatuses.slice(0, 5).join(",") === "401,401,200,403,200" &&
        guardStatuses
          .slice(5)
          .every((status, index) => status === [401, 200, 200, 403][index % 4]) &&
        [0, 1, 3].every(
          (index) => guardCases[index]!.headers.get("cache-control") === "no-store",
        ) &&
        guardTexts.every((text) => !text.includes("opaque-") && !text.includes("invalid-canary")) &&
        guardTexts[0] === '{"error":"unauthorized"}' &&
        guardTexts[3] === '{"error":"forbidden"}',
      `statuses=${guardStatuses.join(",")}`,
    ),
  );

  const unknown = await get(`${base}/api/products/999`);

  ok.push(
    check(
      `${label}: unknown resource → controller-returned 404 JSON, no-store`,
      unknown.status === 404 &&
        unknown.body === '{"error":"not_found"}' &&
        unknown.headers.get("cache-control") === "no-store",
      `${unknown.status} ${unknown.body}`,
    ),
  );

  const repeated = await Promise.all([1, 2, 3].map(() => get(`${base}/api/products/42`)));

  ok.push(
    check(
      `${label}: repeated requests return the same public answer`,
      repeated.every((reply) => reply.status === 200 && reply.body === product.body),
    ),
  );

  if (options.lifecycle) {
    // Request-scoped lifecycle: a new controller instance and a cleanup per request.
    const stats = async (): Promise<{ created: number; cleaned: number }> =>
      json(await get(`${base}/api/lifecycle-stats`));
    const before = await stats();
    const sequential: { instance: number; calls: number }[] = [];

    for (let index = 0; index < 3; index++) {
      sequential.push(json(await get(`${base}/api/products/42/lifecycle`)));
    }

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => get(`${base}/api/products/42/lifecycle`)),
    );
    const instances = [
      ...sequential,
      ...concurrent.map((reply) => json<(typeof sequential)[0]>(reply)),
    ];
    const after = await stats();

    ok.push(
      check(
        `${label}: every request has its own controller instance (calls === 1, 11 distinct instances)`,
        instances.every((i) => i.calls === 1) &&
          new Set(instances.map((i) => i.instance)).size === instances.length &&
          sequential[0]!.instance < sequential[1]!.instance &&
          sequential[1]!.instance < sequential[2]!.instance,
        JSON.stringify(instances),
      ),
      check(
        `${label}: the factory created and cleaned up exactly one controller per request (+11/+11)`,
        after.created - before.created === 11 && after.cleaned - before.cleaned === 11,
        `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      ),
    );
  }

  const native = await get(`${base}/api/native`);

  ok.push(
    check(
      `${label}: the native Nitro route still works next to the controller`,
      native.status === 200 && native.body === '{"source":"analog"}',
      native.body,
    ),
  );

  const controller = [...ok];

  ok.length = 0;

  // Server Component page.
  const page = await get(`${base}/products/42`);
  const html = page.body;

  ok.push(
    check(
      `${label}: GET /products/42 → 200 text/html`,
      page.status === 200 && !!page.headers.get("content-type")?.includes("text/html"),
    ),
    check(
      `${label}: the Server Component rendered on the server (title and computed tier)`,
      html.includes("<h1>Product 42</h1>") &&
        html.includes('<p id="server-tier">Tier: premium</p>'),
    ),
    check(
      `${label}: the server-only repository ran (data-evidence hashes every server-only value)`,
      html.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
      html.match(/data-evidence="[^"]*"/)?.[0] ?? "no evidence",
    ),
    check(
      `${label}: client boundary is protocol v1, ngh-annotated, props are exactly {"productId":"42"}`,
      /<product-availability data-strata-client="product-availability" data-strata-protocol="1" data-strata-props="\{&quot;productId&quot;:&quot;42&quot;\}" ngh="\d+">/.test(
        html,
      ),
      html.match(/<product-availability[^>]*>/)?.[0] ?? "no boundary",
    ),
    check(
      `${label}: the SSR document (HTML, hydration metadata, props) carries no private canary`,
      hasCanary(html).length === 0,
      hasCanary(html).join(", "),
    ),
    check(
      `${label}: SSR shows the island's initial public state`,
      html.includes("Availability: not checked") && html.includes("Refresh availability"),
    ),
  );

  const missing = await get(`${base}/products/999`);

  ok.push(
    check(
      `${label}: an unknown product renders the not-found branch, no island, no canary (status stays 200: documented soft-404)`,
      missing.status === 200 &&
        missing.body.includes('id="not-found"') &&
        !missing.body.includes("<product-availability") &&
        hasCanary(missing.body).length === 0,
    ),
  );
  if (options.log) {
    const { log } = options;

    ok.push(
      check(
        `${label}: the server log shows no JIT fallback or error`,
        !/JIT compilation|needs to be compiled using the JIT|ERROR|Code generation from strings/.test(
          sanitize(log()),
        ),
        sanitize(log()).slice(-600),
      ),
    );
  }

  return { controller, serverComponents: ok };
}

export interface BrowserResult {
  readonly ok: boolean[];
}

export const HYDRATED = "product-availability[data-strata-hydrated]";

/** Browser qualification: SSR DOM reuse, one click = one API request = one state update. */
export async function islandSuite(
  base: string,
  label: string,
  open: () => Promise<Tracked> = openTracked,
): Promise<BrowserResult> {
  const ok: boolean[] = [];
  const tracked = await open();
  const { page } = tracked;
  const bodies: { url: string; type: string; body: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  page.on("response", (response) => {
    const type = response.request().resourceType();

    if (!["document", "script", "fetch", "xhr"].includes(type)) return;
    void response.text().then(
      (body) => bodies.push({ url: response.url(), type, body }),
      () => undefined,
    );
  });
  // Hold the application scripts so the SSR DOM can be tagged before hydration.
  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });

  try {
    // Module scripts are deferred, so DOMContentLoaded would wait for the held scripts.
    await page.goto(`${base}/products/42`, { waitUntil: "commit" });
    await page.waitForSelector("product-availability button", { state: "attached" });

    const before = await evaluate<{
      title: string | null;
      status: string | null;
      hydrated: boolean;
    }>(
      page,
      `(() => {
        const button = document.querySelector('product-availability button');
        const output = document.querySelector('product-availability output');
        window.__ssr = { button, output, outputText: output && output.firstChild, heading: document.querySelector('h1') };
        return {
          title: document.querySelector('h1')?.textContent ?? null,
          status: output?.textContent ?? null,
          hydrated: !!document.querySelector('product-availability[data-strata-hydrated]'),
        };
      })()`,
    );

    release();
    await page.waitForSelector(HYDRATED, { timeout: 15_000 });

    const same = await evaluate<Record<string, boolean>>(
      page,
      `(() => ({
        button: window.__ssr.button === document.querySelector('product-availability button'),
        output: window.__ssr.output === document.querySelector('product-availability output'),
        text: window.__ssr.outputText === document.querySelector('product-availability output').firstChild,
        heading: window.__ssr.heading === document.querySelector('h1'),
      }))()`,
    );
    const hydration = await evaluate<{ ngh: number; islands: number }>(
      page,
      `({ ngh: document.querySelectorAll('[ngh]').length, islands: document.querySelectorAll('[data-strata-hydrated]').length })`,
    );

    ok.push(
      check(
        `${label}: before any script the server HTML is visible with the initial state`,
        before.title === "Product 42" &&
          before.status === "Availability: not checked" &&
          !before.hydrated,
        JSON.stringify(before),
      ),
      check(
        `${label}: the island hydrates reusing the SSR nodes (heading, button, output, text node)`,
        Object.values(same).every(Boolean),
        JSON.stringify(same),
      ),
      check(
        `${label}: no leftover ngh annotation and exactly one island`,
        hydration.ngh === 0 && hydration.islands === 1,
        JSON.stringify(hydration),
      ),
    );

    // One click → exactly one API request → one state update.
    await evaluate(
      page,
      `(() => {
        window.__states = [];
        const output = document.querySelector('product-availability output');
        new MutationObserver(() => window.__states.push(output.textContent)).observe(output, { childList: true, characterData: true, subtree: true });
      })()`,
    );

    const apiRequests = (): string[] =>
      tracked.requests.filter((r) => r.url.endsWith("/api/products/42")).map((r) => r.type);
    const apiBefore = apiRequests().length;
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/products/42")),
      page.click("product-availability button"),
    ]);

    await page.waitForFunction(
      "document.querySelector('product-availability output')?.textContent === 'Availability: available'",
      undefined,
      { timeout: 10_000 },
    );
    // A short quiet period only proves nothing else follows; the facts above are event-driven.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const states = await evaluate<string[]>(page, "window.__states");
    const finalPublic = (await response.json()) as typeof PRODUCT_42;

    ok.push(
      check(
        `${label}: one click sent exactly one fetch to the Strata controller and got the public JSON`,
        apiRequests().length - apiBefore === 1 &&
          response.status() === 200 &&
          JSON.stringify(finalPublic) === JSON.stringify(PRODUCT_42) &&
          response.headers()["x-fullstack-catalog"] === CONTROLLER_FINGERPRINT,
        `${apiRequests().join(",")} ${response.status()}`,
      ),
      check(
        `${label}: the response updated the Angular state exactly once ("Availability: available")`,
        states.length === 1 && states[0] === "Availability: available",
        JSON.stringify(states),
      ),
      check(
        `${label}: the SSR button and output survived the interaction`,
        await evaluate<boolean>(
          page,
          "window.__ssr.button === document.querySelector('product-availability button') && window.__ssr.output === document.querySelector('product-availability output')",
        ),
      ),
    );

    // Confidentiality of everything the browser received or rendered.
    const outer = await evaluate<string>(page, "document.documentElement.outerHTML");
    const received = bodies.map((entry) => `${entry.url}\n${entry.body}`).join("\n");

    ok.push(
      check(
        `${label}: no private canary in the hydrated DOM`,
        hasCanary(outer).length === 0,
        hasCanary(outer).join(", "),
      ),
      check(
        `${label}: no private canary in any document, script or API response the browser received`,
        hasCanary(received).length === 0 && bodies.length > 3,
        `${bodies.length} bodies; ${hasCanary(received).join(", ")}`,
      ),
      check(
        `${label}: the client marker was loaded; the browser received no controller/adapter code`,
        bodies.some((e) => e.type === "script" && e.body.includes(FULL_STACK_MARKERS.client)) &&
          bodies
            .filter((e) => e.type === "script")
            .every(
              (e) =>
                !e.body.includes("registerControllers") &&
                !e.body.includes("getControllerDefinition") &&
                !e.body.includes("ProductsController"),
            ),
      ),
      check(
        `${label}: no console error/warning (no NG hydration, JIT or unlinked-partial message)`,
        tracked.errors.length === 0,
        tracked.errors.join(" | "),
      ),
      check(
        `${label}: no failed network request while loading and using the island`,
        tracked.failedRequests.length === 0,
        tracked.failedRequests.join(" | "),
      ),
    );
  } finally {
    release();
    await tracked.close();
  }

  return { ok };
}

/** Document navigation into and out of the Server Component route. */
export async function navigationSuite(
  base: string,
  label: string,
  open: () => Promise<Tracked> = openTracked,
): Promise<boolean[]> {
  const ok: boolean[] = [];
  const tracked: Tracked = await open();
  const { page } = tracked;
  const hydrated = (): Promise<boolean> =>
    page.waitForSelector(HYDRATED, { timeout: 15_000 }).then(
      () => true,
      () => false,
    );
  const status = (): Promise<string | null> =>
    page.locator("product-availability output").textContent();
  const documentRequests = (fragment: string): number =>
    tracked.requests.filter((r) => r.navigation && r.url.includes(fragment)).length;
  const apiCount = (): number =>
    tracked.requests.filter((r) => r.url.endsWith("/api/products/42")).length;
  const refresh = async (): Promise<string | null> => {
    const mark = apiCount();

    await page.click("product-availability button");
    await page
      .waitForFunction(
        "document.querySelector('product-availability output')?.textContent === 'Availability: available'",
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => undefined);

    return apiCount() - mark === 1 ? await status() : `requests: ${apiCount() - mark}`;
  };

  try {
    // Plain-anchor document navigation.
    await page.goto(`${base}/`, { waitUntil: "load" });
    await evaluate(page, "window.__NAV_SENTINEL__ = 'home'");
    const documentsBefore = documentRequests("/products/42");

    await page.click("#to-product");
    await page.waitForURL("**/products/42");

    const direct = await hydrated();
    const sentinelAfterLink = await evaluate<string | undefined>(page, "window.__NAV_SENTINEL__");

    ok.push(
      check(
        `${label}: document link / → /products/42 is a real document request and the island hydrates`,
        direct &&
          sentinelAfterLink === undefined &&
          documentRequests("/products/42") - documentsBefore === 1,
      ),
      check(
        `${label}: the island works after the document navigation (one click, one request)`,
        (await refresh()) === "Availability: available",
      ),
    );

    // Away, Back, re-entry.
    await page.click("#to-about");
    await page.waitForURL("**/about");
    await page.goBack();
    await page.waitForURL("**/products/42");

    const reentered = await hydrated();
    const fresh = await status();

    ok.push(
      check(
        `${label}: Back re-enters the Server Component page, hydrated, from a fresh state`,
        reentered && fresh === "Availability: not checked",
        `${reentered} ${fresh}`,
      ),
      check(
        `${label}: after re-entry one click is one request and exactly one island exists`,
        (await refresh()) === "Availability: available" &&
          (await evaluate<number>(
            page,
            "document.querySelectorAll('[data-strata-hydrated]').length",
          )) === 1,
      ),
    );

    await page.goForward();
    await page.waitForURL("**/about");
    ok.push(
      check(
        `${label}: Forward reaches /about`,
        (await page.locator("main h1").textContent()) === "About",
      ),
    );

    // The opt-in package guard: an Angular Router link becomes a document request.
    await page.goto(`${base}/`, { waitUntil: "load" });
    await evaluate(page, "window.__NAV_SENTINEL__ = 'router'");
    const guardBefore = documentRequests("/products/42?ref=home");

    await page.click("#router-link");
    await page.waitForURL("**/products/42?ref=home#details");

    const guarded = await hydrated();
    const sentinelAfterGuard = await evaluate<string | undefined>(page, "window.__NAV_SENTINEL__");

    ok.push(
      check(
        `${label}: strataDocumentNavigationGuard turns a Router link into one real document request, preserving query and fragment`,
        guarded &&
          sentinelAfterGuard === undefined &&
          documentRequests("/products/42?ref=home") - guardBefore === 1 &&
          page.url().endsWith("/products/42?ref=home#details"),
        `${page.url()} ${documentRequests("/products/42?ref=home") - guardBefore}`,
      ),
      check(
        `${label}: the island works after the guarded navigation`,
        (await refresh()) === "Availability: available",
      ),
    );

    await page.goBack();
    await page.waitForURL(`${base}/`);
    await page.goForward();
    ok.push(
      check(
        `${label}: Back to / and Forward return to the hydrated product page`,
        (await hydrated()) &&
          (await evaluate<number>(
            page,
            "document.querySelectorAll('[data-strata-hydrated]').length",
          )) === 1,
      ),
      check(
        `${label}: no console error/warning during navigation`,
        tracked.errors.length === 0,
        tracked.errors.join(" | "),
      ),
    );
  } finally {
    await tracked.close();
  }

  return ok;
}

/** The ordinary Angular documents next to the Server Component route. */
export async function documentsSuite(base: string, label: string): Promise<boolean[]> {
  const home = await get(`${base}/`);
  const about = await get(`${base}/about`);
  const isHtml = (reply: Reply): boolean =>
    reply.status === 200 && !!reply.headers.get("content-type")?.includes("text/html");

  return [
    check(
      `${label}: GET / → 200 text/html with the server-rendered landing page and both product links`,
      isHtml(home) &&
        home.body.includes("<h1>Full-stack consumer home</h1>") &&
        home.body.includes('id="to-product"') &&
        home.body.includes('id="router-link"') &&
        hasCanary(home.body).length === 0,
      `${home.status} ${home.body.slice(0, 200)}`,
    ),
    check(
      `${label}: GET /about → 200 text/html with the ordinary Angular About document (no island)`,
      isHtml(about) &&
        about.body.includes("<h1>About</h1>") &&
        !about.body.includes("<product-availability") &&
        hasCanary(about.body).length === 0,
      `${about.status} ${about.body.slice(0, 200)}`,
    ),
  ];
}

/** A reload of the Server Component page hydrates it again from the server HTML. */
export async function reloadSuite(
  base: string,
  label: string,
  open: () => Promise<Tracked> = openTracked,
): Promise<boolean[]> {
  const tracked = await open();
  const { page } = tracked;
  const output = "product-availability output";

  try {
    await page.goto(`${base}/products/42`, { waitUntil: "load" });
    await page.waitForSelector(HYDRATED, { timeout: 15_000 });
    await page.click("product-availability button");
    await page.waitForFunction(
      "document.querySelector('product-availability output')?.textContent === 'Availability: available'",
      undefined,
      { timeout: 10_000 },
    );
    await page.reload({ waitUntil: "load" });

    const hydrated = await page.waitForSelector(HYDRATED, { timeout: 15_000 }).then(
      () => true,
      () => false,
    );

    return [
      check(
        `${label}: refresh re-renders from the server and hydrates one fresh island ("not checked" again)`,
        hydrated &&
          (await page.locator(output).textContent()) === "Availability: not checked" &&
          (await evaluate<number>(
            page,
            "document.querySelectorAll('[data-strata-hydrated]').length",
          )) === 1,
      ),
      check(
        `${label}: no console error/warning across the refresh`,
        tracked.errors.length === 0,
        tracked.errors.join(" | "),
      ),
    ];
  } finally {
    await tracked.close();
  }
}
