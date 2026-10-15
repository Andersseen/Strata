import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

import { edgeHeaders } from "./browser.ts";
import { awaitBrowserReady, awaitReady, describeError, distribution } from "./deployed.ts";
import type { Distribution, NotReadyObservation, ReadyProbe } from "./deployed.ts";
import {
  CONTROLLER_FINGERPRINT,
  EXPECTED_EVIDENCE,
  FULL_STACK_MARKERS,
  FULL_STACK_SERVER_SOURCES,
  PRIVATE_CANARIES,
  PRODUCT_42,
} from "./full-stack-fixture.ts";
import { get } from "./full-stack-verify.ts";
import { check, failureCount, section } from "./harness.ts";
import { captureResponse, headerBlock, variantsOf } from "./leak-scan.ts";
import type { CapturedResponse } from "./leak-scan.ts";
import { openTracked } from "./package-consumer.ts";
import type { Tracked } from "./package-consumer.ts";

/**
 * Remote-only helpers of the full-stack deployed qualification: readiness of a
 * public URL, failure-only browser diagnostics, the public-surface confidentiality
 * scan and the bounded concurrency smoke. They speak HTTP/Chromium only, so the
 * same code runs against local workerd (the rehearsal) and a real Pages URL; the
 * runner decides what the result may be called.
 */

export const PAGE_PROBE: ReadyProbe = { route: "/products/42", needle: "<h1>Product 42</h1>" };

// ---------------------------------------------------------------------------
// Readiness

export interface FullStackReadiness {
  readonly page: Awaited<ReturnType<typeof awaitReady>>;
  readonly api: { ready: boolean; attempts: number; notReady: NotReadyObservation[] };
  readonly browser: Awaited<ReturnType<typeof awaitBrowserReady>> | undefined;
  readonly ready: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `consecutive` correct controller answers in a row (a miss resets the streak), bounded. */
async function awaitApiReady(
  baseUrl: string,
  attempts: number,
  intervalMs: number,
  consecutive: number,
): Promise<FullStackReadiness["api"]> {
  const notReady: NotReadyObservation[] = [];
  let streak = 0;
  let made = 0;

  for (let attempt = 1; attempt <= attempts && streak < consecutive; attempt++) {
    made = attempt;
    try {
      const response = await captureResponse(`${baseUrl}/api/products/42`, 15_000);
      const ok =
        response.status === 200 &&
        !!response.contentType?.includes("application/json") &&
        response.body === JSON.stringify(PRODUCT_42);

      if (!ok)
        notReady.push({ attempt, status: response.status, headers: edgeHeaders(response.headers) });
      streak = ok ? streak + 1 : 0;
    } catch (error) {
      streak = 0;
      notReady.push({ attempt, status: null, headers: {}, error: describeError(error) });
    }
    if (streak < consecutive) await sleep(intervalMs);
  }

  return { ready: streak >= consecutive, attempts: made, notReady };
}

/**
 * Ready = the Server Component page AND the controller answer correctly several times in a row
 * through plain HTTP, and fresh Chromium contexts get the server-rendered page too (a real earlier
 * deployment saw Node and Chromium disagree for a short while). Bounded, never indefinite; every
 * not-ready answer is kept as evidence.
 */
export async function awaitFullStackReady(
  baseUrl: string,
  options: {
    attempts: number;
    intervalMs: number;
    httpConsecutive: number;
    browserConsecutive: number;
  },
): Promise<FullStackReadiness> {
  const { attempts, intervalMs } = options;
  const page = await awaitReady(baseUrl, attempts, intervalMs, options.httpConsecutive, PAGE_PROBE);
  const api = page.ready
    ? await awaitApiReady(baseUrl, attempts, intervalMs, options.httpConsecutive)
    : { ready: false, attempts: 0, notReady: [] };
  const browser =
    page.ready && api.ready
      ? await awaitBrowserReady(
          baseUrl,
          attempts,
          intervalMs,
          options.browserConsecutive,
          PAGE_PROBE,
        )
      : undefined;

  return { page, api, browser, ready: page.ready && api.ready && !!browser?.ready };
}

// ---------------------------------------------------------------------------
// Browser diagnostics

/**
 * `openTracked` plus a Playwright trace and a screenshot that are written to `directory` ONLY
 * if a check failed while the page was open. The public site and the browser carry no credential,
 * so neither artifact can hold a secret; both are bounded by the one page they cover.
 */
export function diagnosedOpener(
  label: string,
  directory: string | undefined,
): () => Promise<Tracked> {
  return async () => {
    if (!directory) return openTracked();

    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: Tracked["requests"] = [];
    const failedRequests: string[] = [];
    const failuresAtOpen = failureCount();

    await context.tracing.start({ screenshots: true, snapshots: true });
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        errors.push(`console.${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("request", (request) =>
      requests.push({
        type: request.resourceType(),
        url: request.url(),
        navigation: request.isNavigationRequest(),
      }),
    );
    page.on("requestfailed", (request) =>
      failedRequests.push(
        `${request.resourceType()} ${request.url()}: ${request.failure()?.errorText ?? "failed"}`,
      ),
    );

    return {
      page,
      errors,
      requests,
      failedRequests,
      close: async () => {
        const failed = failureCount() > failuresAtOpen;

        if (failed) {
          mkdirSync(directory, { recursive: true });
          await page.screenshot({ path: join(directory, `${label}.png`) }).catch(() => {});
        }
        await context.tracing
          .stop(failed ? { path: join(directory, `${label}.trace.zip`) } : undefined)
          .catch(() => {});
        await browser.close().catch(() => {});
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Public-surface confidentiality

/** Encodings scanned besides the raw value (the short numeric cost is matched raw only). */
const SCAN_VARIANTS = /^(raw|lower-case|reversed|base64\+\d|hex|HEX|percent-encoded)$/;

const canaries = PRIVATE_CANARIES.map((value) => ({ label: value, value, family: value }));

/** Private canaries (any scanned encoding) found in `text`; names only, never the values. */
export function privateLeaks(text: string): string[] {
  return canaries.flatMap((canary) => {
    const raw = text.includes(canary.value) ? [`${canary.label.slice(0, 12)}… (raw)`] : [];
    const encoded = variantsOf(canary)
      .filter((variant) => SCAN_VARIANTS.test(variant.name) && variant.needle.length > 8)
      .filter((variant) => variant.name !== "raw" && text.includes(variant.needle))
      .map((variant) => `${canary.label.slice(0, 12)}… (${variant.name})`);

    return [...raw, ...encoded];
  });
}

export function scannerControl(): boolean {
  return (
    PRIVATE_CANARIES.every((canary) => privateLeaks(`x${canary}x`).length > 0) &&
    FULL_STACK_MARKERS.controller.length > 8 &&
    privateLeaks(`x${Buffer.from(FULL_STACK_MARKERS.controller).toString("base64")}x`).length > 0 &&
    privateLeaks(`x${Buffer.from(FULL_STACK_MARKERS.server).toString("hex")}x`).length > 0 &&
    privateLeaks(`x${FULL_STACK_MARKERS.client}x`).length === 0
  );
}

const sourceNames = (text: string): string[] =>
  FULL_STACK_SERVER_SOURCES.filter((name) => text.includes(name));

const serverSourcesInMap = (sources: readonly string[]): string[] =>
  sources.filter(
    (source) =>
      FULL_STACK_SERVER_SOURCES.some(
        (file) => source.endsWith(file) && !source.includes("/generated/"),
      ) || /@strata-sc\/(core|analog)\/|\/src\/server\//.test(source),
  );

export interface SurfaceResult {
  readonly assetsScanned: number;
  readonly sourceMapsScanned: number;
}

/**
 * Everything a browser can fetch without credentials: the SSR document and its headers, the
 * controller JSON and headers, every referenced script/stylesheet, the sibling source maps and
 * the Worker path. Server-only canaries and server source names must be absent; the client marker
 * and the island's source are the positive controls.
 */
export async function surfaceSuite(base: string, label: string): Promise<SurfaceResult> {
  section(`${label}: public-surface confidentiality`);

  check(
    "scanner control: raw, base64 and hex markers are seen, the public client marker is not",
    scannerControl(),
  );

  const pageReply = await captureResponse(`${base}/products/42`);
  const apiReply = await captureResponse(`${base}/api/products/42`);
  const missingReply = await captureResponse(`${base}/api/products/999`);
  const internals = /node_modules|file:\/\/|\n\s+at |\/Users\/|\/home\/|\/runner\/|[A-Z]:\\/;

  for (const [name, reply] of [
    ["SSR document", pageReply],
    ["controller 200 JSON", apiReply],
    ["controller 404 JSON", missingReply],
  ] as const) {
    check(
      `${name}: no private canary or server source name in body or headers; no stack, file URL or absolute path`,
      privateLeaks(`${reply.body}\n${headerBlock(reply)}`).length === 0 &&
        sourceNames(reply.body).length === 0 &&
        !internals.test(`${reply.body}\n${headerBlock(reply)}`),
      privateLeaks(`${reply.body}\n${headerBlock(reply)}`).join(", "),
    );
  }
  check(
    "hydration metadata: every data-strata-props and ngh payload is public (productId only)",
    [...pageReply.body.matchAll(/data-strata-props="([^"]*)"/g)].every(
      (match) => privateLeaks(match[1]!).length === 0 && match[1]!.includes("productId"),
    ),
  );
  check(
    "the SSR document carries the server-computed evidence (positive control: the repository ran)",
    pageReply.body.includes(`data-evidence="${EXPECTED_EVIDENCE}"`),
  );
  check(
    "the controller response carries its evidence header (positive control: the controller ran)",
    apiReply.headers.some(
      ([name, value]) => name === "x-fullstack-catalog" && value === CONTROLLER_FINGERPRINT,
    ),
  );

  const scripts = [...pageReply.body.matchAll(/(?:src|href)="([^"]+\.(?:m?js|css))"/g)]
    .map((match) => new URL(match[1]!, `${base}/`))
    .filter((url) => url.origin === new URL(base).origin)
    .map((url) => url.href);
  // The document names the entry scripts; lazy chunks (the island) are reached through their relative
  // `import("./chunk.js")` specifiers. Bounded crawl, same origin only.
  const queue = [...new Set(scripts)];
  const seen = new Set<string>();
  const MAX_ASSETS = 120;
  let scanned = 0;
  let maps = 0;
  let clientMarker = false;
  let islandSource = false;

  check(
    "the document references application assets (positive control)",
    queue.length > 0,
    `${queue.length}`,
  );
  while (queue.length > 0 && seen.size < MAX_ASSETS) {
    const url = queue.shift()!;

    if (seen.has(url)) continue;
    seen.add(url);

    const asset = await captureResponse(url);

    scanned++;
    clientMarker ||= asset.body.includes(FULL_STACK_MARKERS.client);
    check(
      `asset ${new URL(url).pathname}: 200, no private canary or server source name, none in headers`,
      asset.status === 200 &&
        privateLeaks(asset.body).length === 0 &&
        sourceNames(asset.body).length === 0 &&
        privateLeaks(headerBlock(asset)).length === 0,
      `${asset.status} ${privateLeaks(asset.body).join(", ")}`,
    );
    if (url.endsWith(".js")) {
      for (const match of asset.body.matchAll(/["'](\.{1,2}\/[^"'\s]+\.m?js)["']/g)) {
        const next = new URL(match[1]!, url);

        if (next.origin === new URL(base).origin && !seen.has(next.href)) queue.push(next.href);
      }

      // Vite's preload map names lazy chunks relative to the site root ("assets/x.js").
      for (const match of asset.body.matchAll(/["'](assets\/[^"'\s]+\.m?js)["']/g)) {
        const next = new URL(match[1]!, `${base}/`);

        if (!seen.has(next.href)) queue.push(next.href);
      }

      const map = await captureResponse(`${url}.map`);

      if (map.status === 200 && /^\s*\{/.test(map.body)) {
        maps++;

        const sources = (JSON.parse(map.body) as { sources?: string[] }).sources ?? [];

        islandSource ||= sources.some((source) =>
          source.endsWith("product-availability.component.ts"),
        );
        check(
          `source map ${new URL(url).pathname}.map: no private canary, no server source in sources`,
          privateLeaks(map.body).length === 0 && serverSourcesInMap(sources).length === 0,
          serverSourcesInMap(sources).join(", "),
        );
      }
    }
  }
  check("positive control: the public client marker is in a browser script", clientMarker);
  if (maps > 0)
    check("positive control: a served source map lists the island's source", islandSource);

  // The Worker directory must not be a public static path.
  for (const path of ["/_worker.js", "/_worker.js/index.js", "/_worker.js/index.js.map"]) {
    const worker = await captureResponse(`${base}${path}`);

    check(
      `${path} is not served as a static file (no Worker code, no canary)`,
      privateLeaks(worker.body).length === 0 &&
        !/registerControllers|ProductsController|nitroApp|defineNitroPlugin/.test(worker.body),
      `${worker.status} ${worker.contentType}`,
    );
  }

  return { assetsScanned: scanned, sourceMapsScanned: maps };
}

// ---------------------------------------------------------------------------
// Concurrency

export interface FullStackRound {
  readonly kind: "server-component" | "controller";
  readonly label: string;
  readonly requests: number;
  readonly concurrency: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly statuses: Record<string, number>;
  readonly distribution: Distribution;
  readonly wallMs: number;
  /** Responses that differ from their own baseline, or that echo any request id. */
  readonly crossRequestAnomalies: number;
}

interface Expectation {
  readonly path: string;
  readonly status: number;
  readonly type: string;
  body: string;
}

const PAGE_CASES: Expectation[] = [
  { path: "/products/42", status: 200, type: "text/html", body: "" },
  { path: "/products/999", status: 200, type: "text/html", body: "" },
];
const API_CASES: Expectation[] = [
  { path: "/api/products/42", status: 200, type: "application/json", body: "" },
  { path: "/api/products/7", status: 200, type: "application/json", body: "" },
  { path: "/api/products/999", status: 404, type: "application/json", body: "" },
];

async function round(
  base: string,
  kind: FullStackRound["kind"],
  label: string,
  cases: readonly Expectation[],
  requests: number,
  concurrency: number,
): Promise<FullStackRound> {
  const ids = Array.from(
    { length: requests },
    (_, i) => `req-${kind}-${i}-${Math.random().toString(36).slice(2, 10)}`,
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

      if (index >= requests) return;

      // Alternate the resource so a response that belongs to another request is detectable.
      const expected = cases[index % cases.length]!;
      const start = performance.now();

      try {
        const reply = await get(`${base}${expected.path}?request=${ids[index]}`);

        samples.push(performance.now() - start);
        statuses[String(reply.status)] = (statuses[String(reply.status)] ?? 0) + 1;
        if (
          reply.status === expected.status &&
          !!reply.headers.get("content-type")?.includes(expected.type)
        )
          succeeded++;
        else failed++;
        if (
          reply.body !== expected.body ||
          ids.some((id) => reply.body.includes(id)) ||
          privateLeaks(reply.body).length > 0
        )
          anomalies++;
      } catch {
        failed++;
        statuses["network-error"] = (statuses["network-error"] ?? 0) + 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  return {
    kind,
    label,
    requests,
    concurrency,
    succeeded,
    failed,
    statuses,
    distribution: distribution(samples),
    wallMs: Math.round((performance.now() - wallStart) * 10) / 10,
    crossRequestAnomalies: anomalies,
  };
}

export async function concurrencySuite(base: string): Promise<FullStackRound[]> {
  section("Bounded concurrency smoke (80 requests: documents and controller API)");

  const rounds: FullStackRound[] = [];

  for (const [kind, cases] of [
    ["server-component", PAGE_CASES],
    ["controller", API_CASES],
  ] as const) {
    for (const expected of cases) expected.body = (await get(`${base}${expected.path}`)).body;
    check(
      `${kind}: the baselines of the alternated resources differ (cross-request mixing is detectable)`,
      new Set(cases.map((c) => c.body)).size === cases.length,
    );

    for (const [label, requests, concurrency] of [
      ["sequential baseline", 5, 1],
      ["10 concurrent", 10, 10],
      ["25 concurrent", 25, 25],
    ] as const) {
      const result = await round(base, kind, `${kind}: ${label}`, cases, requests, concurrency);

      rounds.push(result);
      console.log(
        `${result.label}: ${result.succeeded}/${requests} ok, failed ${result.failed}, statuses ${JSON.stringify(result.statuses)}, ` +
          `ms p50 ${result.distribution.p50Ms} p90 ${result.distribution.p90Ms} p95 ${result.distribution.p95Ms} max ${result.distribution.maxMs}, wall ${result.wallMs} ms`,
      );
      check(
        `${result.label}: every response has the expected status and content type (no unexpected 404/5xx)`,
        result.succeeded === requests && result.failed === 0,
        JSON.stringify(result.statuses),
      );
      check(
        `${result.label}: every body equals its own resource's baseline, echoes no request id, leaks no canary`,
        result.crossRequestAnomalies === 0,
        `${result.crossRequestAnomalies} anomalous`,
      );
    }
  }

  return rounds;
}

// ---------------------------------------------------------------------------
// Known limitations, observed (recorded, never asserted as production behavior)

export interface Observation {
  readonly name: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly note: string;
}

export async function observeLimitations(base: string): Promise<Observation[]> {
  const unknownApi = await captureResponse(`${base}/api/does-not-exist`);
  const unknownProduct = await captureResponse(`${base}/products/999`);

  return [
    {
      name: "unmatched /api/* path",
      status: unknownApi.status,
      contentType: unknownApi.contentType,
      note: "known: an unmatched /api/* path may fall through to the Angular HTML document",
    },
    {
      name: "unknown product page /products/999",
      status: unknownProduct.status,
      contentType: unknownProduct.contentType,
      note: "known: the not-found branch renders with HTTP 200 (soft 404)",
    },
  ];
}

export type { CapturedResponse };
