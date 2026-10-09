import { chromium } from "playwright";

import { observeBrowser } from "./browser.ts";
import {
  EXPECTED_EVIDENCE,
  MARKERS,
  SERVER_MARKERS,
  SERVER_MESSAGE_A,
  SERVER_SOURCES,
} from "./consumer-fixture.ts";
import { check, section } from "./harness.ts";
import { captureResponse, headerBlock, variantsOf } from "./leak-scan.ts";
import type { CapturedResponse, Canary } from "./leak-scan.ts";

/**
 * Black-box qualification of a URL that serves the external consumer fixture
 * (tests/server-component-package-consumer/fixture) built for Cloudflare Pages.
 * It only speaks HTTP and drives Chromium: it does not know whether the URL is
 * a public `*.pages.dev` deployment or a local workerd rehearsal; the runner
 * (deployed-cloudflare.ts) decides what the result may be called.
 */

export const ROUTE = "/product";
export const NAVIGATION_TARGET = "/about";

// ---------------------------------------------------------------------------
// Statistics

export interface Distribution {
  readonly count: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p90Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ]!;
}

export function distribution(samples: readonly number[]): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);

  if (sorted.length === 0) return { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, maxMs: 0 };

  return {
    count: sorted.length,
    minMs: round(sorted[0]!),
    p50Ms: round(percentile(sorted, 50)),
    p90Ms: round(percentile(sorted, 90)),
    p95Ms: round(percentile(sorted, 95)),
    maxMs: round(sorted[sorted.length - 1]!),
  };
}

// ---------------------------------------------------------------------------
// Canaries

/**
 * The fixture's synthetic server-only markers as scannable canaries. Only the
 * encodings that cannot collide with the (intentionally public) client marker
 * are used: the family-prefix and unique-suffix variants of `leak-scan` would.
 */
const SCAN_VARIANTS = /^(raw|lower-case|reversed|base64\+\d|hex|HEX|percent-encoded)$/;

const canaries: readonly Canary[] = SERVER_MARKERS.map((value) => ({
  label: value,
  value,
  family: value,
}));

/** Names of the server-only markers (any scanned encoding) found in `text`. */
export function serverLeaks(text: string): string[] {
  return canaries.flatMap((canary) =>
    variantsOf(canary)
      .filter((variant) => SCAN_VARIANTS.test(variant.name) && variant.needle.length > 8)
      .filter((variant) => text.includes(variant.needle))
      .map((variant) => `${canary.label} (${variant.name})`),
  );
}

/** Consumer-authored server file names found in `text` (stack traces, loaded scripts). */
export function serverSourceNames(text: string): string[] {
  return SERVER_SOURCES.filter((name) => text.includes(name));
}

/**
 * Server files named by a source map's `sources`. The generated surrogate shares the
 * Server Component's file name; it is the browser's stand-in, so it is expected.
 */
export function serverSourcesInMap(sources: readonly string[]): string[] {
  return sources.filter((source) =>
    SERVER_SOURCES.some((file) => source.endsWith(file) && !source.includes("/generated/")),
  );
}

/** Scanner control: proves `serverLeaks` can see what it claims to, so a clean scan means something. */
export function scannerControl(): boolean {
  return (
    SERVER_MARKERS.every(
      (marker) =>
        serverLeaks(`x${marker}x`).length > 0 &&
        serverLeaks(`x${Buffer.from(marker).toString("base64")}x`).length > 0 &&
        serverLeaks(`x${Buffer.from(marker).toString("hex")}x`).length > 0,
    ) && serverLeaks(`x${MARKERS.client}x`).length === 0
  );
}

// ---------------------------------------------------------------------------
// Result

export interface ConcurrencyRound {
  readonly label: string;
  readonly requests: number;
  readonly concurrency: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly statuses: Record<string, number>;
  readonly distribution: Distribution;
  readonly wallMs: number;
  /** Responses whose body differs from the baseline body, or that echo any issued request id. */
  readonly crossRequestAnomalies: number;
}

export interface DeployedVerification {
  readonly baseUrl: string;
  readonly firstRequest: {
    readonly attempts: number;
    readonly firstAttemptStatus: number | null;
    readonly firstAttemptMs: number | null;
    readonly readyAfterMs: number;
    readonly note: string;
  };
  readonly headers: readonly string[];
  readonly concurrency: readonly ConcurrencyRound[];
  readonly assetsScanned: number;
  readonly sourceMapsScanned: number;
  readonly navigation: { readonly fromProductToAbout: boolean; readonly reloaded: boolean };
}

// ---------------------------------------------------------------------------
// HTTP

const html = (response: CapturedResponse): boolean =>
  response.status === 200 && !!response.contentType?.includes("text/html");

const timed = async (url: string): Promise<{ response: CapturedResponse; ms: number }> => {
  const start = performance.now();
  const response = await captureResponse(url, 30_000);

  return { response, ms: performance.now() - start };
};

/**
 * A fresh Pages deployment can answer 404/5xx for a short while after
 * `wrangler pages deploy` returns. Polls `/product` (bounded) and records what
 * the very first attempt saw; it is the "first observed request", NOT a
 * confirmed Cloudflare cold start (nothing in the response says so).
 */
export async function awaitReady(
  baseUrl: string,
  attempts = 30,
  intervalMs = 2_000,
): Promise<DeployedVerification["firstRequest"] & { readonly ready: boolean }> {
  const begin = performance.now();
  let firstStatus: number | null = null;
  let firstMs: number | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const start = performance.now();
    let status: number | null;
    let ok: boolean;

    try {
      const response = await captureResponse(`${baseUrl}${ROUTE}`, 15_000);

      status = response.status;
      ok = html(response);
    } catch {
      status = null;
      ok = false;
    }
    if (attempt === 1) {
      firstStatus = status;
      firstMs = round(performance.now() - start);
    }
    if (ok) {
      return {
        ready: true,
        attempts: attempt,
        firstAttemptStatus: firstStatus,
        firstAttemptMs: firstMs,
        readyAfterMs: round(performance.now() - begin),
        note: "first observed request after deploy/start; platform cold-start evidence is not exposed, so this is not classified as a cold start",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    ready: false,
    attempts,
    firstAttemptStatus: firstStatus,
    firstAttemptMs: firstMs,
    readyAfterMs: round(performance.now() - begin),
    note: "never became ready",
  };
}

/** Static asset URLs the document references (same origin only). */
function referencedAssets(document: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  for (const match of document.matchAll(/(?:src|href)="([^"]+\.(?:m?js|css))"/g)) {
    const url = new URL(match[1]!, `${baseUrl}/`);

    if (url.origin === new URL(baseUrl).origin) urls.add(url.href);
  }

  return [...urls];
}

// ---------------------------------------------------------------------------
// Concurrency

async function round_(
  baseUrl: string,
  label: string,
  requests: number,
  concurrency: number,
  baseline: string,
): Promise<ConcurrencyRound> {
  const issued = Array.from(
    { length: requests },
    (_, index) =>
      `req-${label.replace(/\W+/g, "-")}-${index}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const samples: number[] = [];
  const statuses: Record<string, number> = {};
  let succeeded = 0;
  let failed = 0;
  let anomalies = 0;
  let next = 0;
  const wallStart = performance.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;

      if (index >= issued.length) return;

      try {
        const { response, ms } = await timed(`${baseUrl}${ROUTE}?request=${issued[index]}`);

        samples.push(ms);
        statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
        if (html(response)) succeeded++;
        else failed++;
        // The page ignores the query string, so a body must equal the baseline and
        // can never mention any request id: anything else is data from elsewhere.
        if (response.body !== baseline || issued.some((id) => response.body.includes(id)))
          anomalies++;
      } catch {
        failed++;
        statuses["network-error"] = (statuses["network-error"] ?? 0) + 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    label,
    requests,
    concurrency,
    succeeded,
    failed,
    statuses,
    distribution: distribution(samples),
    wallMs: round(performance.now() - wallStart),
    crossRequestAnomalies: anomalies,
  };
}

// ---------------------------------------------------------------------------
// Browser navigation

interface DomPage {
  evaluate<T>(fn: () => T): Promise<T>;
}

async function navigationCheck(
  baseUrl: string,
): Promise<{ fromProductToAbout: boolean; reloaded: boolean; errors: string[] }> {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        errors.push(`console.${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

    await page.goto(`${baseUrl}${ROUTE}`, { waitUntil: "load" });
    await page.waitForSelector("add-to-cart[data-strata-hydrated]", { timeout: 20_000 });
    await (page as unknown as DomPage).evaluate(() => {
      (globalThis as unknown as { __sentinel: boolean }).__sentinel = true;
    });

    // A plain <a href>: a full-document navigation. (Angular Router navigation into a
    // Server Component subtree is a known, unqualified limitation and is not exercised.)
    const documentRequest = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() && request.url() === `${baseUrl}${NAVIGATION_TARGET}`,
      { timeout: 20_000 },
    );

    await page.click("#to-about");
    await documentRequest.catch(() => undefined);
    await page.waitForURL(`${baseUrl}${NAVIGATION_TARGET}`, { timeout: 20_000 });
    await page.getByRole("heading", { name: "About" }).waitFor({ timeout: 20_000 });

    const newRealm = !(await (page as unknown as DomPage).evaluate(
      () => (globalThis as unknown as { __sentinel?: boolean }).__sentinel === true,
    ));

    await page.click("#to-product");
    await page.waitForURL(`${baseUrl}${ROUTE}`, { timeout: 20_000 });
    await page.waitForSelector("add-to-cart[data-strata-hydrated]", { timeout: 20_000 });
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page
      .locator("add-to-cart output")
      .filter({ hasText: "Count: 1" })
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);

    const afterNavigation =
      newRealm &&
      (await page.locator("add-to-cart output").textContent()) === "Count: 1" &&
      (await page.getByRole("heading", { name: "Product 42" }).isVisible());

    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("add-to-cart[data-strata-hydrated]", { timeout: 20_000 });

    const reloaded =
      (await page.locator("add-to-cart output").textContent()) === "Count: 0" &&
      (await page.getByRole("heading", { name: "Product 42" }).isVisible());

    return { fromProductToAbout: afterNavigation, reloaded, errors };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// The qualification

export async function verifyDeployment(
  baseUrl: string,
  firstRequest: DeployedVerification["firstRequest"],
): Promise<DeployedVerification> {
  check(
    "scanner control: the canary scan sees raw, base64 and hex markers, not the client marker",
    scannerControl(),
  );

  // A. Direct loading
  section(`A. Direct load: GET ${baseUrl}${ROUTE}`);

  const direct = await timed(`${baseUrl}${ROUTE}`);
  const body = direct.response.body;

  check(
    "HTTP 200 text/html",
    html(direct.response),
    `${direct.response.status} ${direct.response.contentType}`,
  );
  check(
    "SSR HTML has the server-rendered <h1>Product 42</h1>",
    body.includes("<h1>Product 42</h1>"),
  );
  check(
    `SSR HTML has the server message "${SERVER_MESSAGE_A}"`,
    body.includes(`>${SERVER_MESSAGE_A}</p>`),
  );
  check(
    "SSR HTML carries the server-computed evidence (fingerprints of all three server markers)",
    body.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
  );

  // B. Protocol
  section("B. Boundary protocol");
  check(
    "protocol v1 attribute with an ngh annotation on the client boundary",
    /<add-to-cart data-strata-client="add-to-cart" data-strata-protocol="1"[^>]* ngh="\d+">/.test(
      body,
    ),
    body.match(/<add-to-cart[^>]*>/)?.[0] ?? "no boundary",
  );
  check(
    "exactly one client boundary in the document",
    (body.match(/<add-to-cart\b/g) ?? []).length === 1,
  );

  // C + D. Hydration and interaction
  section("C/D. Hydration and interaction (Chromium)");

  const observed = await observeBrowser(`${baseUrl}${ROUTE}`);

  check(
    "before any script runs the server HTML is already visible (Count: 0)",
    observed.beforeScripts.productVisible && observed.beforeScripts.count === "Count: 0",
  );
  check("the client island hydrates", observed.hydratedWithinTimeout);
  check(
    "SSR DOM nodes are reused (article, heading, button, count text)",
    Object.values(observed.sameNodes).every(Boolean),
    JSON.stringify(observed.sameNodes),
  );
  check(
    "exactly one client boundary, hydrated; no ngh annotation left; no duplicate nodes",
    observed.hydratedIslands === 1 && observed.remainingHydrationAnnotations === 0,
    `hydrated ${observed.hydratedIslands}, ngh left ${observed.remainingHydrationAnnotations}`,
  );
  check(
    "initial Count: 0; one click → Count: 1; the SSR button survives",
    observed.countAfterHydration === "Count: 0" &&
      observed.countAfterClick === "Count: 1" &&
      observed.buttonSurvivedClick,
    `${observed.countAfterHydration} → ${observed.countAfterClick}`,
  );
  check(
    "no console error or warning (no hydration error)",
    observed.errors.length === 0,
    observed.errors.join(" | "),
  );

  // E. Navigation
  section(
    "E. Document navigation, reload (Angular Router navigation is a known limitation, not tested)",
  );

  const navigation = await navigationCheck(baseUrl);

  check(
    `link click is a document navigation to ${NAVIGATION_TARGET} (new JS realm); back to ${ROUTE} hydrates and counts`,
    navigation.fromProductToAbout,
  );
  check("reload: server HTML hydrates again with Count: 0", navigation.reloaded);
  check(
    "no console error or warning during navigation",
    navigation.errors.length === 0,
    navigation.errors.join(" | "),
  );

  const direct2 = await captureResponse(`${baseUrl}${NAVIGATION_TARGET}`);

  check(
    "direct GET /about → 200 text/html with the About page",
    html(direct2) && direct2.body.includes("<h1>About</h1>"),
  );

  // Confidentiality
  section("Confidentiality: server-only canaries on every client-visible surface");

  check(
    "HTML: no server-only marker",
    serverLeaks(body).length === 0,
    serverLeaks(body).join(", "),
  );
  check(
    "HTML: no server-only source file name",
    serverSourceNames(body).length === 0,
    serverSourceNames(body).join(", "),
  );
  check(
    "HTML response headers: no server marker, stack, file URL or absolute path; no x-powered-by",
    serverLeaks(headerBlock(direct.response)).length === 0 &&
      !/node_modules|file:\/\/|\n\s+at |\/Users\/|\/home\/|[A-Z]:\\/.test(
        headerBlock(direct.response),
      ) &&
      !direct.response.headers.some(([name]) => name === "x-powered-by"),
    headerBlock(direct.response)
      .split("\n")
      .map((line) => line.split(":")[0])
      .join(", "),
  );
  check(
    "positive control: the public client marker IS in the browser scripts",
    observed.scripts.some((script) => script.body.includes(MARKERS.client)),
  );
  check(
    "every script the browser loaded: no server-only marker or source file name",
    observed.scripts.every(
      (script) =>
        serverLeaks(script.body).length === 0 && serverSourceNames(script.body).length === 0,
    ),
    observed.scripts
      .filter((script) => serverLeaks(script.body).length > 0)
      .map((script) => script.url)
      .join(", "),
  );
  check(
    "positive control: the browser loaded at least one application script",
    observed.scripts.length > 0,
    `${observed.scripts.length}`,
  );

  const assets = [
    ...new Set([
      ...referencedAssets(body, baseUrl),
      ...observed.scripts.map((script) => script.url).filter((url) => url.startsWith(baseUrl)),
    ]),
  ];
  const maps: CapturedResponse[] = [];
  let assetsScanned = 0;

  for (const url of assets) {
    const asset = await captureResponse(url);

    assetsScanned++;
    check(
      `asset ${new URL(url).pathname}: 200, no server marker/source name, no marker in headers`,
      asset.status === 200 &&
        serverLeaks(asset.body).length === 0 &&
        serverSourceNames(asset.body).length === 0 &&
        serverLeaks(headerBlock(asset)).length === 0,
      `${asset.status}`,
    );
    // Source maps: referenced by comment, or by the conventional sibling path.
    if (url.endsWith(".js")) {
      const map = await captureResponse(`${url}.map`);

      if (map.status === 200 && /^\s*\{/.test(map.body)) maps.push(map);
    }
  }

  const mapSources = maps.map((map) => {
    try {
      return (JSON.parse(map.body) as { sources?: string[] }).sources ?? [];
    } catch {
      return [];
    }
  });

  console.log(`public source maps found beside the served scripts: ${maps.length}`);
  check(
    "source maps (when served): no server marker, no server source file in `sources`",
    maps.every((map) => serverLeaks(map.body).length === 0) &&
      mapSources.every((sources) => serverSourcesInMap(sources).length === 0),
    mapSources.flatMap(serverSourcesInMap).join(", "),
  );
  if (maps.length > 0) {
    check(
      "positive control: the served source maps list the client island's source",
      mapSources.flat().some((source) => source.includes("add-to-cart.component.ts")),
    );
  }

  const worker = await captureResponse(`${baseUrl}/_worker.js/index.js`);

  check(
    "the Worker bundle is not served as a static file (/_worker.js/index.js)",
    serverLeaks(worker.body).length === 0 && !worker.body.includes("nitro"),
    `${worker.status} ${worker.contentType}`,
  );
  check(
    "the protocol payload (data-strata-props) carries only the public props",
    [...body.matchAll(/data-strata-props="([^"]*)"/g)].every(
      (match) => serverLeaks(match[1]!).length === 0 && match[1]!.includes("productId"),
    ),
  );

  // Concurrency smoke
  section("Bounded concurrency smoke (40 requests in total)");

  const baseline = direct.response.body;
  const rounds: ConcurrencyRound[] = [];

  for (const [label, requests, concurrency] of [
    ["sequential baseline", 5, 1],
    ["10 concurrent", 10, 10],
    ["25 concurrent", 25, 25],
  ] as const) {
    const result = await round_(baseUrl, label, requests, concurrency, baseline);

    rounds.push(result);
    console.log(
      `${label}: ${result.succeeded}/${requests} ok, failed ${result.failed}, statuses ${JSON.stringify(result.statuses)}, ` +
        `ms p50 ${result.distribution.p50Ms} p90 ${result.distribution.p90Ms} p95 ${result.distribution.p95Ms} max ${result.distribution.maxMs}, wall ${result.wallMs} ms`,
    );
    check(
      `${label}: every response is 200 text/html`,
      result.succeeded === requests && result.failed === 0,
    );
    check(
      `${label}: every body is identical to the baseline and echoes no request id`,
      result.crossRequestAnomalies === 0,
      `${result.crossRequestAnomalies} anomalous`,
    );
  }

  return {
    baseUrl,
    firstRequest,
    headers: direct.response.headers.map(([name]) => name),
    concurrency: rounds,
    assetsScanned,
    sourceMapsScanned: maps.length,
    navigation: {
      fromProductToAbout: navigation.fromProductToAbout,
      reloaded: navigation.reloaded,
    },
  };
}
