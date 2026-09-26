import { chromium } from "playwright";
import type { Browser, Page, Request } from "playwright";

/**
 * Chromium flows of the server-component navigation PoC
 * (docs/research/server-component-navigation-poc.md). Each flow starts from a
 * fresh browser context and returns what it observed; navigation.ts asserts.
 */

export const ORIGIN = "/server-component-navigation";
export const DESTINATION = "/server-component";

export interface RequestRecord {
  readonly phase: string;
  readonly method: string;
  readonly resourceType: string;
  readonly url: string;
  /** A request for a new document (the browser's navigation request). */
  readonly navigation: boolean;
  /** The response body contained server-rendered product data ("Product 42"). */
  readonly carriedServerHtml: boolean;
}

export interface ScriptRecord {
  readonly url: string;
  readonly body: string;
}

/** A point-in-time read of the document. */
export interface DomSnapshot {
  readonly url: string;
  /** The sentinel set before the navigation survived: the same JavaScript realm. */
  readonly sentinel: boolean;
  /** Navigation Timing entry of the current document: its URL and type. */
  readonly documentEntry: string;
  readonly originHeading: boolean;
  readonly serverComponentHosts: number;
  /** Child elements of `<product-details>` (0 when the surrogate rendered alone). */
  readonly serverComponentChildren: number;
  readonly articles: number;
  readonly productText: boolean;
  readonly addToCartHosts: number;
  readonly hydratedIslands: number;
  readonly remainingHydrationAnnotations: number;
  readonly count: string | null;
  /** Fixture-only counters (src/server-components/islands.ts, probe.ts). */
  readonly islandsCreated: number;
  readonly islandsDestroyed: number;
  readonly routerEvents: readonly string[];
}

export interface Session {
  readonly page: Page;
  readonly errors: string[];
  readonly requests: RequestRecord[];
  readonly scripts: ScriptRecord[];
  /** Bodies of document responses, by URL path. */
  readonly documents: Map<string, string>;
  /** Labels the requests that follow. */
  phase(name: string): void;
  snapshot(): Promise<DomSnapshot>;
}

// The tools' tsconfig has no DOM lib. These are the only DOM shapes the
// callbacks below (which run in the page, not in Node) rely on.
interface DomElement {
  readonly childElementCount: number;
  readonly textContent: string | null;
}

declare const document: {
  readonly body: DomElement;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): { readonly length: number };
};
declare const window: {
  __STRATA_NAVIGATION_SENTINEL__?: string;
  __STRATA_ISLAND_PROBE__?: { created: number; destroyed: number };
  __STRATA_ROUTER_PROBE__?: string[];
  readonly location: { readonly pathname: string };
};
declare const performance: {
  getEntriesByType(type: string): readonly { readonly name: string; readonly type: string }[];
};

const SENTINEL = "set-before-navigation";

async function open(browser: Browser, url: string): Promise<Session> {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  const requests: RequestRecord[] = [];
  const scripts: ScriptRecord[] = [];
  const documents = new Map<string, string>();
  const phases = new WeakMap<Request, string>();
  let phase = "load";

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => errors.push(`requestfailed: ${request.url()}`));
  page.on("request", (request) => phases.set(request, phase));
  page.on("response", async (response) => {
    const request = response.request();
    const current = phases.get(request) ?? phase;
    const body = await response.text().catch(() => "");

    requests.push({
      phase: current,
      method: request.method(),
      resourceType: request.resourceType(),
      url: new URL(request.url()).pathname,
      navigation: request.isNavigationRequest(),
      carriedServerHtml: body.includes("Product 42"),
    });
    if (request.resourceType() === "script") scripts.push({ url: request.url(), body });
    if (request.resourceType() === "document") documents.set(new URL(request.url()).pathname, body);
  });

  await page.goto(url);
  await page.waitForLoadState("networkidle");

  return {
    page,
    errors,
    requests,
    scripts,
    documents,
    phase: (name) => {
      phase = name;
    },
    snapshot: () =>
      page.evaluate(() => {
        const host = document.querySelector("product-details");
        const islands = window.__STRATA_ISLAND_PROBE__;
        const entry = performance.getEntriesByType("navigation")[0];

        return {
          url: window.location.pathname,
          sentinel: window.__STRATA_NAVIGATION_SENTINEL__ === "set-before-navigation",
          documentEntry: entry ? `${new URL(entry.name).pathname} (${entry.type})` : "none",
          originHeading:
            document.querySelector("h1")?.textContent === "Server Component Navigation Probe",
          serverComponentHosts: document.querySelectorAll("product-details").length,
          serverComponentChildren: host?.childElementCount ?? 0,
          articles: document.querySelectorAll("product-details article").length,
          productText: document.body.textContent?.includes("Product 42") ?? false,
          addToCartHosts: document.querySelectorAll("add-to-cart").length,
          hydratedIslands: document.querySelectorAll("[data-strata-hydrated]").length,
          remainingHydrationAnnotations: document.querySelectorAll("[ngh]").length,
          count: document.querySelector("add-to-cart output")?.textContent ?? null,
          islandsCreated: islands?.created ?? 0,
          islandsDestroyed: islands?.destroyed ?? 0,
          routerEvents: [...(window.__STRATA_ROUTER_PROBE__ ?? [])],
        };
      }),
  };
}

async function setSentinel(session: Session): Promise<void> {
  await session.page.evaluate((value) => {
    window.__STRATA_NAVIGATION_SENTINEL__ = value;
  }, SENTINEL);
}

/** Waits for the fixture probe to record a completed router navigation to `path`. */
async function routerSettled(session: Session, path: string, previousEvents: number) {
  await session.page
    .waitForFunction(
      ([target, skip]) =>
        (window.__STRATA_ROUTER_PROBE__ ?? [])
          .slice(skip)
          .some((event) => event === `end ${target}` || event.startsWith("error ")),
      [path, previousEvents] as const,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await session.page.waitForLoadState("networkidle");
}

async function hydrated(session: Session): Promise<boolean> {
  return session.page
    .waitForSelector("add-to-cart[data-strata-hydrated]", { state: "attached", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/** Clicks Add to cart once and returns the count it settles on. */
async function addToCart(session: Session): Promise<string | null> {
  const output = session.page.locator("add-to-cart output");
  const before = await output.textContent();

  await session.page.getByRole("button", { name: "Add to cart" }).click();
  await session.page
    .waitForFunction(
      (previous) => document.querySelector("add-to-cart output")?.textContent !== previous,
      before,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  // Let a second (duplicate) handler, if any, land before reading.
  await session.page.waitForTimeout(250);

  return output.textContent();
}

export interface DocumentFlow {
  readonly afterNavigation: DomSnapshot;
  readonly islandHydrated: boolean;
  readonly countAfterClick: string | null;
  /** Its `sentinel` is true only if Back restored the origin from the back/forward cache. */
  readonly afterBack: DomSnapshot;
  readonly reentry: DomSnapshot;
  readonly reentryHydrated: boolean;
  readonly reentryCounts: readonly (string | null)[];
  readonly session: Session;
}

/**
 * origin → plain anchor → destination → click → Back → plain anchor again →
 * two clicks. The strategy expected to work: every hop is a new document.
 */
async function documentFlow(browser: Browser, baseUrl: string): Promise<DocumentFlow> {
  const session = await open(browser, `${baseUrl}${ORIGIN}`);
  const { page } = session;

  await setSentinel(session);
  session.phase("document navigation");
  await page.getByRole("link", { name: "Document navigation" }).click();
  await page.waitForURL(`**${DESTINATION}`);

  const islandHydrated = await hydrated(session);

  await page.waitForLoadState("networkidle");

  const afterNavigation = await session.snapshot();
  const countAfterClick = await addToCart(session);

  session.phase("back");
  await page.goBack({ waitUntil: "load" });
  await page.waitForLoadState("networkidle");

  const afterBack = await session.snapshot();

  session.phase("document re-entry");
  await page.getByRole("link", { name: "Document navigation" }).click();
  await page.waitForURL(`**${DESTINATION}`);

  const reentryHydrated = await hydrated(session);

  await page.waitForLoadState("networkidle");

  const reentry = await session.snapshot();
  const reentryCounts = [await addToCart(session), await addToCart(session)];

  return {
    afterNavigation,
    islandHydrated,
    countAfterClick,
    afterBack,
    reentry,
    reentryHydrated,
    reentryCounts,
    session,
  };
}

export interface RouterFlow {
  readonly beforeNavigation: DomSnapshot;
  readonly afterNavigation: DomSnapshot;
  readonly afterBack: DomSnapshot;
  readonly reentry: DomSnapshot;
  readonly session: Session;
}

/**
 * origin → RouterLink → destination → Back → RouterLink again. The
 * characterization under test: nothing is fixed before it is measured.
 */
async function routerFlow(browser: Browser, baseUrl: string): Promise<RouterFlow> {
  const session = await open(browser, `${baseUrl}${ORIGIN}`);
  const { page } = session;

  await setSentinel(session);

  const beforeNavigation = await session.snapshot();

  session.phase("router navigation");
  await page.getByRole("link", { name: "Router navigation" }).click();
  await routerSettled(session, DESTINATION, beforeNavigation.routerEvents.length);

  const afterNavigation = await session.snapshot();

  session.phase("router back");
  await page.goBack();
  await routerSettled(session, ORIGIN, afterNavigation.routerEvents.length);

  const afterBack = await session.snapshot();

  session.phase("router re-entry");
  await page.getByRole("link", { name: "Router navigation" }).click();
  await routerSettled(session, DESTINATION, afterBack.routerEvents.length);

  return {
    beforeNavigation,
    afterNavigation,
    afterBack,
    reentry: await session.snapshot(),
    session,
  };
}

export interface TeardownFlow {
  readonly loaded: DomSnapshot;
  readonly countAfterClick: string | null;
  readonly afterLeave: DomSnapshot;
  readonly afterRouterReentry: DomSnapshot;
  readonly session: Session;
}

/**
 * Direct load of the destination (hydrated island) → RouterLink away →
 * RouterLink back. Observes what Angular does with the island ComponentRefs
 * when the route, and with it the surrogate, is destroyed.
 */
async function teardownFlow(browser: Browser, baseUrl: string): Promise<TeardownFlow> {
  const session = await open(browser, `${baseUrl}${DESTINATION}`);
  const { page } = session;

  await hydrated(session);
  await setSentinel(session);

  const loaded = await session.snapshot();
  const countAfterClick = await addToCart(session);

  session.phase("router leave");
  await page.getByRole("link", { name: "Leave (router)" }).click();
  await routerSettled(session, ORIGIN, loaded.routerEvents.length);

  const afterLeave = await session.snapshot();

  session.phase("router re-entry after teardown");
  await page.getByRole("link", { name: "Router navigation" }).click();
  await routerSettled(session, DESTINATION, afterLeave.routerEvents.length);

  return {
    loaded,
    countAfterClick,
    afterLeave,
    afterRouterReentry: await session.snapshot(),
    session,
  };
}

export interface NavigationObservation {
  readonly document: DocumentFlow;
  readonly router: RouterFlow;
  readonly teardown: TeardownFlow;
}

export async function observeNavigation(baseUrl: string): Promise<NavigationObservation> {
  const browser = await chromium.launch();

  try {
    return {
      document: await documentFlow(browser, baseUrl),
      router: await routerFlow(browser, baseUrl),
      teardown: await teardownFlow(browser, baseUrl),
    };
  } finally {
    await browser.close();
  }
}
