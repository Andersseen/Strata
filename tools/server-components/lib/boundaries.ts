import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

import {
  ADVERSARIAL_TEXT,
  PRIMITIVES,
} from "../../../apps/analog-fixture/src/app/boundary-protocol/boundary-values.ts";
import { httpGet } from "../../analog/lib/process.ts";

import { check, section } from "./harness.ts";

/**
 * Client boundary protocol qualification against the Analog fixture's
 * `/server-component-boundaries` route (BoundaryProtocolServerComponent):
 * protocol attribute, primitive and adversarial-string round-trip, DOM-host
 * identity of two identical boundaries, and teardown. With `full`, also the
 * fail-closed paths: tampered SSR markup (Playwright response interception,
 * no production test API), commit rollback, and the invalid-props SSR route.
 */

export const BOUNDARIES_ROUTE = "/server-component-boundaries";
export const INVALID_ROUTE = "/server-component-boundary-invalid";
const OWNER = "boundary-protocol";

const EXPECTED = {
  primitives: { label: "primitives", ...PRIMITIVES },
  escaping: { label: "escaping", text: ADVERSARIAL_TEXT, count: -1.5, enabled: false, empty: null },
} as const;

// The tools' tsconfig has no DOM lib. These are the only DOM shapes the
// callbacks below (which run in the page, not in Node) rely on.
interface DomElement {
  readonly textContent: string | null;
  readonly firstChild: DomElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): DomElement | null;
}

declare const document: {
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): { readonly length: number };
};
declare const window: {
  __STRATA_XSS__?: unknown;
  __STRATA_BOUNDARY_FAIL__?: string;
  __strataBoundaryNodes?: readonly (DomElement | null)[];
  __strataBoundarySentinel?: string;
  __STRATA_ISLAND_PROBE__?: { created: number; destroyed: number; views(): number };
};

const all = (results: readonly boolean[]): boolean => results.every(Boolean);

/** Selectors of the SSR nodes whose identity hydration must preserve. */
const IDENTITY_NODES = [
  'boundary-counter[data-counter="A"]',
  'boundary-counter[data-counter="A"] button',
  'boundary-counter[data-counter="A"] output',
  'boundary-counter[data-counter="B"]',
  'boundary-counter[data-counter="B"] button',
  'boundary-counter[data-counter="B"] output',
  'boundary-probe[data-probe="escaping"] p',
];

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
};

/** Decodes an HTML attribute value as a browser would (the entities SSR emits). */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));

    return HTML_ENTITIES[name] ?? entity;
  });
}

interface Session {
  readonly page: Page;
  readonly errors: string[];
  readonly documentRequests: string[];
}

interface OpenOptions {
  /** Rewrites the route's SSR HTML before the browser parses it. */
  readonly tamper?: (html: string) => string;
  /** Runs before any page script (fixture-only switches). */
  readonly init?: () => void;
  /** Captures IDENTITY_NODES before application scripts run. */
  readonly captureNodes?: boolean;
  /** Present once the SSR markup is parsed (default: the last boundary of the route). */
  readonly ready?: string;
}

async function open(browser: Browser, url: string, options: OpenOptions = {}): Promise<Session> {
  const page = await browser.newPage();
  const errors: string[] = [];
  const documentRequests: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      documentRequests.push(new URL(request.url()).pathname);
    }
  });

  if (options.init) await page.addInitScript(options.init);

  const { tamper } = options;

  if (tamper) {
    await page.route(url, async (route) => {
      const response = await route.fetch();

      await route.fulfill({ response, body: tamper(await response.text()) });
    });
  }

  await page.route("**/*.js", async (route) => {
    await released;
    await route.continue();
  });
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForSelector(
    options.ready ?? `${OWNER} boundary-probe[data-probe="escaping"] output`,
    { state: "attached" },
  );

  if (options.captureNodes) {
    await page.evaluate((selectors) => {
      window.__strataBoundaryNodes = selectors.map((selector) => document.querySelector(selector));
    }, IDENTITY_NODES);
  }

  release();
  await page.waitForLoadState("load");

  return { page, errors, documentRequests };
}

interface IslandState {
  readonly hydrated: number;
  readonly created: number;
  readonly destroyed: number;
  readonly views: number;
  readonly xss: boolean;
}

const islandState = (page: Page): Promise<IslandState> =>
  page.evaluate(() => ({
    hydrated: document.querySelectorAll("[data-strata-hydrated]").length,
    created: window.__STRATA_ISLAND_PROBE__?.created ?? -1,
    destroyed: window.__STRATA_ISLAND_PROBE__?.destroyed ?? -1,
    views: window.__STRATA_ISLAND_PROBE__?.views() ?? -1,
    xss: "__STRATA_XSS__" in window,
  }));

/** Waits until the app has bootstrapped and had time to run its after-render hooks. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__STRATA_ISLAND_PROBE__ !== undefined, undefined, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1_000);
}

const text = (page: Page, selector: string): Promise<string | null> =>
  page.locator(selector).textContent();

/** Clicks Report on a probe and returns the JSON it reports from its browser inputs. */
async function report(page: Page, probe: string): Promise<unknown> {
  const output = `boundary-probe[data-probe="${probe}"] output`;

  await page.locator(`boundary-probe[data-probe="${probe}"] button`).click();
  await page
    .waitForFunction((selector) => !!document.querySelector(selector)?.textContent, output, {
      timeout: 5_000,
    })
    .catch(() => undefined);

  const reported = await text(page, output);

  return reported ? (JSON.parse(reported) as unknown) : null;
}

const same = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

function checkSsr(html: string): boolean {
  const hosts = [...html.matchAll(/<(boundary-counter|boundary-probe)\s[^>]*>/g)].map((m) => m[0]);
  const escapingTag = hosts.find((tag) => tag.includes('data-probe="escaping"')) ?? "";
  const escapingProps = escapingTag.match(/\sdata-strata-props="([^"]*)"/)?.[1];
  const decoded = ((): unknown => {
    try {
      return escapingProps === undefined ? null : JSON.parse(decodeAttribute(escapingProps));
    } catch {
      return "(attribute is not JSON after HTML decoding)";
    }
  })();

  console.log(`escaping boundary host: ${escapingTag}`);

  return all([
    check(
      'four boundary hosts, each with data-strata-client, data-strata-protocol="1", data-strata-props and ngh, in that order',
      hosts.length === 4 &&
        hosts.every((tag) =>
          /\sdata-strata-client="([a-z-]+)" data-strata-protocol="1" data-strata-props="[^"]*" ngh="\d+">$/.test(
            tag,
          ),
        ),
      hosts.join(" | "),
    ),
    check(
      "the two identical boundaries carry identical selector and props (no boundary id)",
      hosts.filter((tag) => tag.includes('data-strata-props="{&quot;start&quot;:0}"')).length ===
        2 && !/data-strata-(?:id|index)/.test(html),
    ),
    check(
      "adversarial props stay inside the attribute: no raw <script>globalThis.__STRATA_XSS__ in the HTML",
      !html.includes("<script>globalThis.__STRATA_XSS__"),
    ),
    check(
      "the escaping host's attribute HTML-decodes to the exact serialized props",
      same(decoded, EXPECTED.escaping),
      JSON.stringify(decoded),
    ),
    check(
      "no global payload: props live only on their host (no __STRATA_DATA__, not in Angular's ng-state)",
      !html.includes("__STRATA_DATA__") &&
        !(html.match(/<script id="ng-state"[^>]*>[^<]*/)?.[0] ?? "").includes("Plain text"),
    ),
  ]);
}

async function checkPositive(browser: Browser, baseUrl: string, teardown: boolean) {
  const session = await open(browser, `${baseUrl}${BOUNDARIES_ROUTE}`, { captureNodes: true });
  const { page } = session;

  try {
    const hydrated = await page
      .waitForFunction(
        (owner) => document.querySelectorAll(`${owner} [data-strata-hydrated]`).length === 4,
        OWNER,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    const state = await islandState(page);
    const identity = await page.evaluate(
      (selectors) =>
        selectors.map(
          (selector, index) =>
            !!window.__strataBoundaryNodes?.[index] &&
            window.__strataBoundaryNodes[index] === document.querySelector(selector),
        ),
      IDENTITY_NODES,
    );
    const browserProps = await page.evaluate(() =>
      document
        .querySelector('boundary-probe[data-probe="escaping"]')
        ?.getAttribute("data-strata-props"),
    );
    const escapingText = await text(page, 'boundary-probe[data-probe="escaping"] p');

    const counters = {
      a: 'boundary-counter[data-counter="A"]',
      b: 'boundary-counter[data-counter="B"]',
    };
    const counts = async () => [
      await text(page, `${counters.a} output`),
      await text(page, `${counters.b} output`),
    ];
    const initial = await counts();

    await page.locator(`${counters.a} button`).click();
    await page
      .waitForFunction(
        (selector) => document.querySelector(selector)?.textContent === "Count: 1",
        `${counters.a} output`,
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    const afterA = await counts();

    await page.locator(`${counters.b} button`).click();
    await page.locator(`${counters.b} button`).click();
    await page
      .waitForFunction(
        (selector) => document.querySelector(selector)?.textContent === "Count: 2",
        `${counters.b} output`,
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    const afterB = await counts();
    const primitives = await report(page, "primitives");
    const escaping = await report(page, "escaping");
    const xssAfter = await page.evaluate(() => "__STRATA_XSS__" in window);

    const ok = all([
      check("all four boundaries hydrate", hydrated),
      check(
        "StrataIslandHost created four islands (two identical counters are two ComponentRefs)",
        state.created === 4 && state.hydrated === 4,
        JSON.stringify(state),
      ),
      check(
        "hydration reused each SSR host and its nodes (identity per DOM host)",
        identity.every(Boolean),
        JSON.stringify(Object.fromEntries(IDENTITY_NODES.map((s, i) => [s, identity[i]]))),
      ),
      check(
        "identical boundaries keep independent state: A +1 → A 1, B 0; B +2 → A 1, B 2",
        same(initial, ["Count: 0", "Count: 0"]) &&
          same(afterA, ["Count: 1", "Count: 0"]) &&
          same(afterB, ["Count: 1", "Count: 2"]),
        `${JSON.stringify(initial)} → ${JSON.stringify(afterA)} → ${JSON.stringify(afterB)}`,
      ),
      check(
        "primitive round-trip: the island received text, count 42, enabled true, empty null (and aliased label)",
        same(primitives, EXPECTED.primitives),
        JSON.stringify(primitives),
      ),
      check(
        "adversarial/Unicode round-trip: the island received the exact original string",
        same(escaping, EXPECTED.escaping),
        JSON.stringify(escaping),
      ),
      check(
        "the browser's parsed data-strata-props equals the serialized props",
        browserProps !== null &&
          browserProps !== undefined &&
          same(JSON.parse(browserProps), EXPECTED.escaping),
      ),
      check(
        "the rendered text node is the exact original string",
        escapingText === ADVERSARIAL_TEXT,
        JSON.stringify(escapingText),
      ),
      check("globalThis.__STRATA_XSS__ was never set", !state.xss && !xssAfter),
      check(
        "no console errors, warnings or page errors",
        session.errors.length === 0,
        session.errors.join(" | "),
      ),
    ]);

    if (!teardown) return { ok, views: state.views };

    await page.getByRole("link", { name: "Leave (router)" }).click();
    await page
      .waitForFunction(
        () => document.querySelector("app-server-component-navigation-page") !== null,
        undefined,
        { timeout: 10_000 },
      )
      .catch(() => undefined);

    const after = await islandState(page);

    return {
      ok: all([
        ok,
        check(
          "router leave destroys all four islands and detaches their views",
          after.destroyed === 4 && after.views === state.views - 4,
          `${JSON.stringify(state)} → ${JSON.stringify(after)}`,
        ),
      ]),
      views: state.views,
    };
  } finally {
    await page.close();
  }
}

interface TamperCase {
  readonly name: string;
  readonly tamper: (html: string) => string;
  /** Expected in the Strata preflight error. */
  readonly reason: string;
  /** 1-based boundary position named in the error. */
  readonly boundary: number;
}

/** Replaces the `nth` (0-based) match of `pattern` in `html`. */
function replaceNth(html: string, pattern: RegExp, nth: number, replacement: string): string {
  let index = -1;

  return html.replace(new RegExp(pattern.source, "g"), (match) =>
    ++index === nth ? replacement : match,
  );
}

const TAMPER_CASES: readonly TamperCase[] = [
  {
    name: 'version skew: boundary B has data-strata-protocol="999"',
    tamper: (html) => replaceNth(html, /data-strata-protocol="1"/, 1, 'data-strata-protocol="999"'),
    reason: 'data-strata-protocol="999" is not supported by this runtime',
    boundary: 2,
  },
  {
    name: "invalid JSON in the last boundary's data-strata-props",
    tamper: (html) =>
      html.replace(/(data-probe="escaping"[^>]*data-strata-props=")[^"]*"/, '$1{broken"'),
    reason: "data-strata-props is not valid JSON",
    boundary: 4,
  },
  {
    name: "unknown input on boundary A (checked with reflectComponentType)",
    tamper: (html) =>
      replaceNth(
        html,
        /data-strata-props="\{&quot;start&quot;:0\}"/,
        0,
        'data-strata-props="{&quot;start&quot;:0,&quot;doesNotExist&quot;:1}"',
      ),
    reason: 'prop "doesNotExist" is not an input of the component',
    boundary: 1,
  },
  {
    name: "aliased input under its property name (caption instead of label)",
    tamper: (html) =>
      html.replace(
        "{&quot;label&quot;:&quot;primitives&quot;",
        "{&quot;caption&quot;:&quot;primitives&quot;",
      ),
    reason:
      'prop "caption" is not a public input name; the input\'s public (aliased) name is "label"',
    boundary: 3,
  },
];

async function checkTampered(browser: Browser, baseUrl: string, tamperCase: TamperCase) {
  section(`Tampered markup: ${tamperCase.name}`);

  const session = await open(browser, `${baseUrl}${BOUNDARIES_ROUTE}`, {
    tamper: tamperCase.tamper,
    captureNodes: true,
  });
  const { page } = session;

  try {
    await settle(page);
    await page.evaluate(() => {
      window.__strataBoundarySentinel = "same document";
    });

    const state = await islandState(page);
    const identity = await page.evaluate(
      (selectors) =>
        selectors.every(
          (selector, index) =>
            window.__strataBoundaryNodes?.[index] === document.querySelector(selector),
        ),
      IDENTITY_NODES,
    );

    await page.locator('boundary-counter[data-counter="A"] button').click();
    await page.waitForTimeout(500);

    const countA = await text(page, 'boundary-counter[data-counter="A"] output');
    const sentinel = await page.evaluate(() => window.__strataBoundarySentinel);
    const expected = `[strata] Cannot hydrate client boundary <`;
    const strataErrors = session.errors.filter((e) => e.includes(expected));
    const named = strataErrors.some(
      (e) =>
        e.includes(`(boundary ${tamperCase.boundary} of 4 in <${OWNER}>)`) &&
        e.includes(tamperCase.reason),
    );

    return {
      ok: all([
        check(
          "zero islands hydrated: no ComponentRef created, no boundary marked",
          state.created === 0 && state.hydrated === 0,
          JSON.stringify(state),
        ),
        check("SSR DOM left in place (same nodes, text visible)", identity),
        check(
          "interaction is not active (click on A keeps Count: 0)",
          countA === "Count: 0",
          String(countA),
        ),
        check(
          `one clear Strata error naming the boundary and reason (${tamperCase.reason})`,
          strataErrors.length === 1 && named,
          session.errors.join(" | ") || "(no errors)",
        ),
        check(
          "no reload or CSR fallback (one document request, same realm)",
          session.documentRequests.length === 1 && sentinel === "same document",
          `${session.documentRequests.join(", ")} sentinel=${String(sentinel)}`,
        ),
      ]),
      views: state.views,
      errors: session.errors,
    };
  } finally {
    await page.close();
  }
}

async function checkRollback(browser: Browser, baseUrl: string, baselineViews: number) {
  section("Commit rollback: the fourth island's constructor throws after three were created");

  const session = await open(browser, `${baseUrl}${BOUNDARIES_ROUTE}`, {
    init: () => {
      window.__STRATA_BOUNDARY_FAIL__ = "escaping";
    },
    captureNodes: true,
  });
  const { page } = session;

  try {
    await settle(page);

    const state = await islandState(page);
    const identity = await page.evaluate(
      (selectors) =>
        selectors.every(
          (selector, index) =>
            !!window.__strataBoundaryNodes?.[index] &&
            window.__strataBoundaryNodes[index] === document.querySelector(selector),
        ),
      IDENTITY_NODES,
    );

    await page.locator('boundary-counter[data-counter="A"] button').click();
    await page.waitForTimeout(500);

    const countA = await text(page, 'boundary-counter[data-counter="A"] output');
    const visible = await text(page, 'boundary-probe[data-probe="escaping"] p');

    return all([
      check(
        "three islands were created and attached, then all three destroyed",
        state.created === 3 && state.destroyed === 3,
        JSON.stringify(state),
      ),
      check(
        "no attached view left: ApplicationRef.viewCount equals the zero-island baseline",
        state.views === baselineViews,
        `${state.views} vs ${baselineViews}`,
      ),
      check("no boundary marked hydrated", state.hydrated === 0, String(state.hydrated)),
      check("the rolled-back hosts' SSR nodes are back in place (same nodes)", identity),
      check(
        "rolled-back islands are inert (click on A keeps Count: 0)",
        countA === "Count: 0",
        String(countA),
      ),
      check("server-rendered content still visible", visible === ADVERSARIAL_TEXT),
      check(
        "the commit error propagates (injected failure reported)",
        session.errors.some((e) => e.includes("[fixture] injected island failure")),
        session.errors.join(" | "),
      ),
    ]);
  } finally {
    await page.close();
  }
}

async function checkInvalidSsr(browser: Browser, baseUrl: string, serverOutput: () => string) {
  section(`Invalid props at SSR: GET ${INVALID_ROUTE} (a cast smuggles a Date)`);

  const before = serverOutput().length;
  const response = await httpGet(`${baseUrl}${INVALID_ROUTE}`);
  const host = response.body.match(/<boundary-counter[^>]*>/)?.[0] ?? "(no host)";

  for (
    let waited = 0;
    waited < 3_000 && !serverOutput().slice(before).includes("[strata]");
    waited += 100
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const log = serverOutput().slice(before);

  console.log(`HTTP ${response.status}; boundary host: ${host}`);
  console.log(`server log: ${log.match(/\[strata\][^\n]*/)?.[0] ?? "(none)"}`);

  const ssr = all([
    check(
      "SSR reports a Strata error naming the boundary, prop, received type and allowed values",
      log.includes(
        '[strata] Cannot serialize client boundary <boundary-counter>: prop "createdAt": Date is not supported.',
      ) && log.includes("Allowed values: string | finite number | boolean | null"),
      log.slice(0, 1_000),
    ),
    check(
      "the invalid value never reaches the HTML: no data-strata-props, nothing coerced",
      !host.includes("data-strata-props") && !response.body.includes("1970-01-01"),
      host,
    ),
  ]);

  // Angular reports template errors to its ErrorHandler and completes the
  // render; the status is Angular/Analog's (characterized, not asserted).
  console.log(`characterized: Angular SSR completed the render with HTTP ${response.status}`);

  const session = await open(browser, `${baseUrl}${INVALID_ROUTE}`, {
    ready: "boundary-invalid boundary-counter output",
  });
  const { page } = session;

  try {
    await settle(page);

    const state = await islandState(page);

    return all([
      ssr,
      check(
        "browser: the props-less boundary fails preflight and nothing hydrates",
        state.created === 0 &&
          state.hydrated === 0 &&
          session.errors.some((e) => e.includes("data-strata-props is missing")),
        `${JSON.stringify(state)} ${session.errors.join(" | ")}`,
      ),
    ]);
  } finally {
    await page.close();
  }
}

export interface BoundaryProtocolResult {
  readonly ssr: boolean;
  readonly positive: boolean;
  readonly failClosed: boolean | "not run";
}

export async function checkBoundaryProtocol(
  baseUrl: string,
  options: {
    readonly runtime: string;
    readonly full: boolean;
    readonly serverOutput?: () => string;
  },
): Promise<BoundaryProtocolResult> {
  section(`${options.runtime}: client boundary protocol — GET ${BOUNDARIES_ROUTE}`);

  const response = await httpGet(`${baseUrl}${BOUNDARIES_ROUTE}`);
  const ssr = all([
    check(
      "HTTP 200 text/html",
      response.status === 200 && !!response.contentType?.includes("text/html"),
    ),
    checkSsr(response.body),
  ]);

  section(`${options.runtime}: client boundary protocol — Chromium`);

  const browser = await chromium.launch();

  try {
    const positive = await checkPositive(browser, baseUrl, options.full);

    if (!options.full) return { ssr, positive: positive.ok, failClosed: "not run" };

    const tampered = [];

    for (const tamperCase of TAMPER_CASES)
      tampered.push(await checkTampered(browser, baseUrl, tamperCase));

    const baseline = tampered[0]?.views ?? -1;

    check(
      "attached views: zero-island baseline + 4 islands = the hydrated page's viewCount",
      positive.views === baseline + 4,
      `${positive.views} vs ${baseline} + 4`,
    );

    const rollback = await checkRollback(browser, baseUrl, baseline);
    const invalid = options.serverOutput
      ? await checkInvalidSsr(browser, baseUrl, options.serverOutput)
      : false;

    return {
      ssr,
      positive: positive.ok,
      failClosed: all([
        ...tampered.map((t) => t.ok),
        positive.views === baseline + 4,
        rollback,
        invalid,
      ]),
    };
  } finally {
    await browser.close();
  }
}
