import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";

import type { Browser, Page } from "playwright";

import { check, fixtureDir, repoRoot, section } from "./harness.ts";
import { captureResponse, expectNoInternals, headerBlock, summarize } from "./leak-scan.ts";
import type { CapturedResponse } from "./leak-scan.ts";
import type { RuntimeTarget } from "./security.ts";

/**
 * Server Component failure and recovery qualification
 * (docs/research/server-component-failure-recovery.md), against the Analog
 * fixture's `/server-component-failures` (three independent hosts, A, B, C)
 * and `/server-component-failure/:mode` (one failing Server Component) routes,
 * on whichever runtime serves them (Nitro `node-server` or Wrangler's local
 * Pages runtime). Buffered SSR and document navigation only.
 *
 * Failure taxonomy (each case has its own expected result):
 *   A server render failure           checkServerRenderFailures
 *   B boundary serialization failure  checkSerializationFailures
 *   C browser boundary preflight      checkPreflightIsolation
 *   D browser hydration commit        checkCommitFailure
 *   E island error after hydration    checkPostHydrationError
 *   F navigation to a failing doc     checkDocumentNavigation
 */

export const FAILURES_ROUTE = "/server-component-failures";
export const failureRoute = (mode: string): string => `/server-component-failure/${mode}`;

const HOSTS = ["A", "B", "C"] as const;
const KEYS = HOSTS.flatMap((host) => ["1", "2", "3"].map((island) => `${host}:${island}`));
const SENSITIVE_ROOTS = [...new Set([repoRoot, fixtureDir, homedir()])];
const HANDLE_ERROR = /\[fixture-error-handler\] handleError (\w+)/g;

const all = (results: readonly boolean[]): boolean => results.every(Boolean);

// The tools' tsconfig has no DOM lib. These are the only DOM shapes the
// callbacks below (which run in the page, not in Node) rely on.
interface DomNode {
  readonly textContent: string | null;
  readonly parentNode: DomNode | null;
  readonly nextSibling: DomNode | null;
  readonly innerHTML: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): DomNode | null;
}

interface CapturedNode {
  readonly node: DomNode | null;
  readonly parent: DomNode | null;
  readonly next: DomNode | null;
}

declare const document: {
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): { readonly length: number };
  readonly body: DomNode;
};
declare const window: {
  __STRATA_FAILURE__?: Record<string, string>;
  __STRATA_FAILURE_PROBE__?: {
    constructed: Record<string, number>;
    destroyed: Record<string, number>;
  };
  __STRATA_ERROR_PROBE__?: string[];
  __STRATA_ISLAND_PROBE__?: { created: number; destroyed: number; views(): number };
  __strataFailureNodes?: readonly CapturedNode[];
  __strataSentinel?: string;
  __strataPageshows?: boolean[];
  addEventListener(type: "pageshow", listener: (event: { persisted: boolean }) => void): void;
};
declare const performance: {
  readonly timeOrigin: number;
  getEntriesByType(type: string): readonly { readonly type?: string }[];
};

// ---------------------------------------------------------------------------
// Server log and HTTP helpers

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's console output since `before`, once `until` appeared (or 8 s), plus a grace for duplicates. */
async function logSince(target: RuntimeTarget, before: number, until: RegExp): Promise<string> {
  for (let waited = 0; waited < 8_000; waited += 100) {
    if (until.test(stripVTControlCharacters(target.output().slice(before)))) break;

    await sleep(100);
  }

  await sleep(600);

  return stripVTControlCharacters(target.output().slice(before));
}

const handled = (log: string): string[] =>
  [...log.matchAll(HANDLE_ERROR)].map((match) => match[1] ?? "");

/** Everything a run records about one response, for the evidence log. */
function describe(response: CapturedResponse): void {
  console.log(`  response: ${summarize(response)}`);
  console.log(`  headers: ${response.headers.map(([name]) => name).join(", ")}`);
  console.log(`  body: ${JSON.stringify(response.body.replace(/<head>[\s\S]*<\/head>/, ""))}`);
}

const SCRIPTS = /<script[\s\S]*?<\/script>/g;
const bodyOnly = (html: string): string =>
  (html.match(/<body[\s\S]*<\/body>/)?.[0] ?? html).replace(SCRIPTS, "");

// ---------------------------------------------------------------------------
// Browser session

interface DocumentRecord {
  readonly path: string;
  readonly status: number;
  readonly body: string;
}

interface Session {
  readonly page: Page;
  readonly console: string[];
  readonly pageErrors: string[];
  readonly documents: DocumentRecord[];
}

interface OpenOptions {
  /** Rewrites the route's SSR HTML before the browser parses it. */
  readonly tamper?: (html: string) => string;
  /** Runs before any page script, in every document of the page (fixture-only switches). */
  readonly init?: () => void;
  /** Element selectors whose node, parent and next sibling are captured before scripts run. */
  readonly capture?: readonly string[];
}

async function openSession(
  browser: Browser,
  url: string,
  options: OpenOptions = {},
): Promise<Session> {
  const page = await browser.newPage();
  const session: Session = { page, console: [], pageErrors: [], documents: [] };
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      session.console.push(`${message.type()}: ${message.text().split("\n")[0]}`);
    }
  });
  page.on("pageerror", (error) => session.pageErrors.push(error.message));
  page.on("response", (response) => {
    const request = response.request();

    if (request.isNavigationRequest() && request.resourceType() === "document") {
      void (async () => {
        const body = await response.text().catch(() => "");

        session.documents.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
          body,
        });
      })();
    }
  });

  await page.addInitScript(() => {
    window.__strataPageshows = [];
    window.addEventListener("pageshow", (event) => {
      window.__strataPageshows?.push(event.persisted);
    });
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
  await page.waitForSelector('failure-host[data-host="C"] output, failure-scenario, app-root', {
    state: "attached",
  });

  if (options.capture) {
    await page.evaluate((selectors) => {
      window.__strataFailureNodes = selectors.map((selector) => {
        const node = document.querySelector(selector);

        return { node, parent: node?.parentNode ?? null, next: node?.nextSibling ?? null };
      });
    }, options.capture);
  }

  release();
  await page.waitForLoadState("load");

  return session;
}

/** Waits for the app to bootstrap, then gives its after-render hooks time to run. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__STRATA_ISLAND_PROBE__ !== undefined, undefined, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1_500);
}

interface State {
  readonly hydrated: Record<string, number>;
  readonly constructed: Record<string, number>;
  readonly destroyed: Record<string, number>;
  readonly views: number;
  readonly errors: readonly string[];
}

const readState = (page: Page): Promise<State> =>
  page.evaluate(() => ({
    hydrated: Object.fromEntries(
      ["A", "B", "C"].map((host) => [
        host,
        document.querySelectorAll(`failure-host[data-host="${host}"] [data-strata-hydrated]`)
          .length,
      ]),
    ),
    constructed: { ...window.__STRATA_FAILURE_PROBE__?.constructed },
    destroyed: { ...window.__STRATA_FAILURE_PROBE__?.destroyed },
    views: window.__STRATA_ISLAND_PROBE__?.views() ?? -1,
    errors: [...(window.__STRATA_ERROR_PROBE__ ?? [])],
  }));

const island = (key: string): string => {
  const [host, number] = key.split(":");

  return `failure-host[data-host="${host}"] failure-island[data-island="${number}"]`;
};

const outputText = (page: Page, key: string): Promise<string | null> =>
  page.locator(`${island(key)} output`).textContent();

/** One real click, then long enough for a duplicate effect to show; returns the island's output. */
async function pressOnce(page: Page, key: string): Promise<string | null> {
  await page.locator(`${island(key)} button`).click();
  await page.waitForTimeout(600);

  return outputText(page, key);
}

/** The captured SSR nodes are still the document's nodes, in the same position. */
const sameNodes = (page: Page, selectors: readonly string[]): Promise<boolean> =>
  page.evaluate(
    (list) =>
      list.every((selector, index) => {
        const before = window.__strataFailureNodes?.[index];
        const node = document.querySelector(selector);

        return (
          !!before?.node &&
          before.node === node &&
          before.parent === node?.parentNode &&
          before.next === node?.nextSibling
        );
      }),
    selectors,
  );

const hostNodes = (host: string): string[] => [
  `failure-host[data-host="${host}"]`,
  `failure-host[data-host="${host}"] [data-ssr-text]`,
  ...["1", "2", "3"].flatMap((number) => {
    const base = island(`${host}:${number}`);

    return [base, `${base} button`, `${base} output`];
  }),
];

const sumOf = (record: Record<string, number>, keys: readonly string[]): number =>
  keys.reduce((sum, key) => sum + (record[key] ?? 0), 0);

const keysOf = (host: string): string[] => KEYS.filter((key) => key.startsWith(`${host}:`));

/** Expected `hydrated` per host: `{A: 3, B: 0, C: 3}` style. */
const hydratedIs = (state: State, expected: Record<string, number>): boolean =>
  HOSTS.every((host) => state.hydrated[host] === expected[host]);

const isStrataBoundaryError = (entry: string | undefined): boolean =>
  entry?.startsWith("StrataBoundaryError:") ?? false;

// ---------------------------------------------------------------------------
// Positive control

export interface Healthy {
  readonly ok: boolean;
  /** `ApplicationRef.viewCount` with nine live islands (the baseline of the failure runs). */
  readonly views: number;
}

/** The failures page, untouched: SSR, nine hydrated islands, interaction, zero error reports. */
export async function checkHealthyBaseline(
  target: RuntimeTarget,
  browser: Browser,
): Promise<Healthy> {
  section(`${target.name}: healthy baseline — GET ${FAILURES_ROUTE}`);

  const before = target.output().length;
  const response = await captureResponse(`${target.baseUrl}${FAILURES_ROUTE}`);
  const log = await logSince(target, before, /^$/m);
  const hosts = response.body.match(/<failure-island [^>]*>/g) ?? [];

  const ssr = all([
    check(
      "HTTP 200 text/html",
      response.status === 200 && !!response.contentType?.includes("text/html"),
      summarize(response),
    ),
    check(
      "three Server Component hosts and nine complete boundaries (client, protocol 1, props, ngh)",
      (response.body.match(/<failure-host /g) ?? []).length === 3 &&
        hosts.length === 9 &&
        hosts.every((tag) =>
          /data-strata-client="failure-island" data-strata-protocol="1" data-strata-props="[^"]*" ngh="\d+"/.test(
            tag,
          ),
        ),
      hosts[0],
    ),
    check(
      "zero error reports on the server for a healthy render",
      handled(log).length === 0 && !/^ERROR /m.test(log),
      log.slice(0, 500),
    ),
  ]);

  const session = await openSession(browser, `${target.baseUrl}${FAILURES_ROUTE}`);
  const { page } = session;

  try {
    await settle(page);

    const state = await readState(page);
    const a1 = await pressOnce(page, "A:1");
    const c3 = await pressOnce(page, "C:3");
    const b2 = await pressOnce(page, "B:2");
    const untouched = await outputText(page, "A:2");

    return {
      views: state.views,
      ok: all([
        ssr,
        check(
          "all nine islands hydrate (3 + 3 + 3) and each was constructed once",
          hydratedIs(state, { A: 3, B: 3, C: 3 }) &&
            KEYS.every((key) => state.constructed[key] === 1),
          JSON.stringify(state),
        ),
        check(
          "one click, one effect (A:1, C:3, B:2 → Presses: 1; A:2 untouched)",
          a1 === "Presses: 1" &&
            c3 === "Presses: 1" &&
            b2 === "Presses: 1" &&
            untouched === "Presses: 0",
          JSON.stringify([a1, c3, b2, untouched]),
        ),
        check(
          "zero ErrorHandler reports, console errors or page errors",
          state.errors.length === 0 &&
            session.console.length === 0 &&
            session.pageErrors.length === 0,
          JSON.stringify([state.errors, session.console, session.pageErrors]),
        ),
      ]),
    };
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// A. Server render failure

interface RenderCase {
  readonly mode: "constructor" | "service" | "template";
  readonly message: string;
}

const RENDER_CASES: readonly RenderCase[] = [
  { mode: "constructor", message: "Synthetic constructor failure" },
  { mode: "service", message: "Synthetic service failure" },
  { mode: "template", message: "Synthetic template failure" },
];

/**
 * Buffered SSR when a Server Component throws while Angular renders it. Pinned,
 * not endorsed: HTTP 200 plus an empty outlet (construction) or a half-rendered
 * component (template) is the exact current Angular/Analog behaviour, not a
 * Strata success response.
 */
export async function checkServerRenderFailures(
  target: RuntimeTarget,
  browser: Browser,
): Promise<boolean> {
  const results: boolean[] = [];

  section(`${target.name}: render-failure control (${failureRoute("none")} does not throw)`);

  const before = target.output().length;
  const control = await captureResponse(`${target.baseUrl}${failureRoute("none")}`);
  const controlLog = await logSince(target, before, /^$/m);

  results.push(
    check(
      "the control renders its Server Component with a complete boundary and zero error reports",
      control.status === 200 &&
        control.body.includes("data-failure-ssr") &&
        control.body.includes("tail rendered") &&
        /data-strata-protocol="1" data-strata-props="[^"]*"/.test(control.body) &&
        handled(controlLog).length === 0,
      summarize(control),
    ),
  );

  for (const { mode, message } of RENDER_CASES) {
    section(`${target.name}: server render failure — ${mode} (GET ${failureRoute(mode)})`);

    const start = target.output().length;
    const response = await captureResponse(`${target.baseUrl}${failureRoute(mode)}`);
    const log = await logSince(target, start, /\[fixture-error-handler\]/);
    const body = bodyOnly(response.body);

    describe(response);
    console.log(
      `  server log: ErrorHandler.handleError ×${handled(log).length} (${handled(log).join(", ")}); ` +
        `error line "${message}" ${log.includes(`ERROR Error: ${message}`) || log.includes(message) ? "present" : "absent"}`,
    );

    const outcome =
      mode === "template"
        ? check(
            "pinned: HTTP 200 with a HALF-RENDERED component (rendered text kept, bindings after the throw empty, island host without any data-strata-* attribute)",
            response.status === 200 &&
              body.includes("data-failure-ssr") &&
              /<p data-failure-tail="">(<!--ngetn-->)?<\/p>/.test(body) &&
              !/<failure-island[^>]*data-strata-/.test(body) &&
              body.includes("data-failure-sibling"),
            body,
          )
        : check(
            "pinned: HTTP 200 with an EMPTY router outlet (no page, no component, no boundary attribute)",
            response.status === 200 &&
              /<router-outlet><\/router-outlet><!----><\/app-root>/.test(body) &&
              !body.includes("failure-scenario") &&
              !body.includes("data-failure-") &&
              !body.includes("data-strata-"),
            body,
          );

    results.push(
      outcome,
      check(
        "text/html, and the response carries no error status the platform did not give it",
        !!response.contentType?.includes("text/html") && response.status === 200,
        summarize(response),
      ),
      check(
        "the error reached the server's Angular ErrorHandler exactly once",
        handled(log).length === 1 && handled(log)[0] === "Error",
        log.slice(0, 700),
      ),
      check(
        "operator log (not public) names the synthetic error",
        log.includes(message),
        log.slice(0, 300),
      ),
      check(
        "public response: no error message, stack frame or sensitive path",
        !response.body.includes(message) &&
          !response.body.includes("Synthetic") &&
          !/\n\s+at /.test(response.body) &&
          !headerBlock(response).includes("Synthetic"),
      ),
      expectNoInternals(`${mode} response body`, response.body, SENSITIVE_ROOTS),
    );

    // The browser takes the 200 response as it is. Pin what it ends up showing.
    const session = await openSession(browser, `${target.baseUrl}${failureRoute(mode)}`);
    const { page } = session;

    try {
      await settle(page);

      const dom = await page.evaluate(() => ({
        component: document.querySelector("failure-scenario")?.innerHTML ?? null,
        sibling: document.querySelector("[data-failure-sibling]")?.textContent ?? null,
        tail: document.querySelector("[data-failure-tail]")?.textContent ?? null,
        hydrated: document.querySelectorAll("[data-strata-hydrated]").length,
        created: window.__STRATA_ISLAND_PROBE__?.created ?? -1,
      }));

      console.log(
        `  browser: component ${JSON.stringify(dom.component?.slice(0, 120))}, page sibling ${JSON.stringify(dom.sibling)}, ` +
          `hydrated ${dom.hydrated}, console ${session.console.length}, page errors ${session.pageErrors.length}`,
      );
      results.push(
        mode === "template"
          ? check(
              "pinned browser result: the half-rendered DOM stays visible and inert (no boundary to find, no hydration, no browser error)",
              dom.component?.includes("Scenario rendered") === true &&
                dom.tail === "" &&
                dom.hydrated === 0 &&
                dom.created === 0 &&
                session.console.length === 0,
              JSON.stringify(dom),
            )
          : check(
              "pinned browser result: Angular's client render shows the page around an EMPTY component (the surrogate renders nothing); no island, no browser error",
              dom.component === "" &&
                dom.sibling === "Page sibling" &&
                dom.hydrated === 0 &&
                dom.created === 0 &&
                session.console.length === 0,
              JSON.stringify(dom),
            ),
        check("no page error", session.pageErrors.length === 0, session.pageErrors.join(" | ")),
      );
    } finally {
      await page.close();
    }
  }

  return all(results);
}

// ---------------------------------------------------------------------------
// B. Boundary serialization failure

const SERIALIZATION_CASES = [
  { mode: "instance", reason: /prop "start": an instance of \w+ is not supported\./ },
  { mode: "nested", reason: /prop "start": a nested object is not supported\./ },
  { mode: "nan", reason: /prop "start": the non-finite number NaN is not supported\./ },
] as const;

/**
 * `[strataClient]` runtime rejection at SSR. Pinned: the render still answers
 * HTTP 200 with the rest of the component, and the rejecting boundary host
 * keeps the attributes Angular applied BEFORE the throw (client, protocol) and
 * never gets `data-strata-props`. The browser's preflight refuses such a host.
 */
export async function checkSerializationFailures(
  target: RuntimeTarget,
  browser: Browser,
): Promise<boolean> {
  const results: boolean[] = [];

  for (const { mode, reason } of SERIALIZATION_CASES) {
    section(`${target.name}: serialization failure — ${mode} (GET ${failureRoute(mode)})`);

    const start = target.output().length;
    const response = await captureResponse(`${target.baseUrl}${failureRoute(mode)}`);
    const log = await logSince(target, start, /\[fixture-error-handler\]/);
    const body = bodyOnly(response.body);
    const host = body.match(/<failure-island [^>]*>/)?.[0] ?? "(no boundary host)";

    describe(response);
    console.log(`  boundary host: ${host}`);
    console.log(
      `  server log: ErrorHandler.handleError ×${handled(log).length} (${handled(log).join(", ")})`,
    );

    results.push(
      check(
        "pinned: HTTP 200, the Server Component's other output renders, the boundary host is incomplete",
        response.status === 200 &&
          body.includes("data-failure-ssr") &&
          body.includes("tail rendered") &&
          body.includes("data-failure-sibling"),
        summarize(response),
      ),
      check(
        "no data-strata-props anywhere in the response, so no hydratable boundary with an unserialized value",
        !/data-strata-props/.test(response.body) &&
          host.includes('data-strata-client="failure-island"') &&
          host.includes('data-strata-protocol="1"'),
        host,
      ),
      check(
        "the rejected value is not in the HTML (no class name, no NaN, no nested object)",
        !/FailureRepository|NaN|rows/.test(response.body),
      ),
      check(
        "one StrataBoundaryError reached the server ErrorHandler, naming the prop and the reason",
        handled(log).length === 1 &&
          handled(log)[0] === "StrataBoundaryError" &&
          reason.test(log) &&
          log.includes("[strata] Cannot serialize client boundary <failure-island>"),
        log.slice(0, 500),
      ),
      expectNoInternals(`${mode} response body`, response.body, SENSITIVE_ROOTS),
    );

    const session = await openSession(browser, `${target.baseUrl}${failureRoute(mode)}`);
    const { page } = session;

    try {
      await settle(page);

      const state = await readState(page);
      const visible = await page.evaluate(() => ({
        ssr: document.querySelector("[data-failure-ssr]")?.textContent ?? null,
        tail: document.querySelector("[data-failure-tail]")?.textContent ?? null,
        islands: document.querySelectorAll("failure-island").length,
        created: window.__STRATA_ISLAND_PROBE__?.created ?? -1,
      }));
      const reported = state.errors.filter(isStrataBoundaryError);

      results.push(
        check(
          "the browser never hydrates the failed boundary: zero islands, zero hydrated markers, SSR DOM visible",
          visible.created === 0 &&
            sumOf(state.constructed, KEYS) === 0 &&
            HOSTS.every((h) => state.hydrated[h] === 0) &&
            visible.ssr === "Scenario rendered" &&
            visible.tail === "tail rendered" &&
            visible.islands === 1,
          JSON.stringify({ visible, state }),
        ),
        check(
          "preflight reports exactly one StrataBoundaryError (props missing) to the ErrorHandler, once on the console, no page error",
          state.errors.length === 1 &&
            reported.length === 1 &&
            reported[0]?.includes("data-strata-props is missing") === true &&
            session.console.length === 1 &&
            session.pageErrors.length === 0,
          JSON.stringify([state.errors, session.console, session.pageErrors]),
        ),
        check(
          "no reload, no retry loop (one document request, still one report after more time)",
          session.documents.length === 1 &&
            (await (async () => {
              await page.waitForTimeout(1_500);

              return (await readState(page)).errors.length === 1;
            })()),
        ),
      );
    } finally {
      await page.close();
    }
  }

  return all(results);
}

// ---------------------------------------------------------------------------
// C. Browser preflight failure and sibling-host isolation

/** The `n`-th (1-based) boundary start tag of `host`, rewritten by `edit`. */
function tamperBoundary(
  html: string,
  host: string,
  n: number,
  edit: (tag: string) => string,
): string {
  const start = html.indexOf(`<failure-host data-host="${host}"`);
  const next = html.indexOf("<failure-host", start + 1);
  const end = next < 0 ? html.length : next;
  const slice = html.slice(start, end);
  const tag = slice.match(new RegExp(`<failure-island data-island="${n}"[^>]*>`))?.[0];

  if (start < 0 || !tag) throw new Error(`tamper: no boundary ${n} in host ${host}`);

  return html.slice(0, start) + slice.replace(tag, edit(tag)) + html.slice(end);
}

interface PreflightCase {
  readonly name: string;
  readonly tamper: (html: string) => string;
  /** Substrings the one StrataBoundaryError must contain. */
  readonly reports: readonly string[];
  /** Substrings no diagnostic may contain (data safety). */
  readonly never: readonly string[];
}

const PREFLIGHT_CASES: readonly PreflightCase[] = [
  {
    name: 'protocol mismatch: host B boundary 2 has data-strata-protocol="999" (1 and 3 valid)',
    tamper: (html) =>
      tamperBoundary(html, "B", 2, (tag) =>
        tag.replace('data-strata-protocol="1"', 'data-strata-protocol="999"'),
      ),
    reports: ["(boundary 2 of 3 in <failure-host>)", 'data-strata-protocol="999" is not supported'],
    never: [],
  },
  {
    name: "malformed props: host B boundary 2 has invalid JSON (1 and 3 valid)",
    tamper: (html) =>
      tamperBoundary(html, "B", 2, (tag) =>
        tag.replace(/data-strata-props="[^"]*"/, 'data-strata-props="{SECRETISH-BROKEN-PAYLOAD"'),
      ),
    reports: ["(boundary 2 of 3 in <failure-host>)", "data-strata-props is not valid JSON."],
    never: ["SECRETISH-BROKEN-PAYLOAD"],
  },
  {
    name: "stale client assets: every boundary of host B is protocol 999 (new server, old browser runtime)",
    tamper: (html) =>
      [1, 2, 3].reduce(
        (current, n) =>
          tamperBoundary(current, "B", n, (tag) =>
            tag.replace('data-strata-protocol="1"', 'data-strata-protocol="999"'),
          ),
        html,
      ),
    reports: ["(boundary 1 of 3 in <failure-host>)", 'data-strata-protocol="999"'],
    never: [],
  },
];

/**
 * Host B is corrupted before hydration; A and C are not. One host = one
 * hydration transaction: B is entirely inert with its SSR DOM, A and C hydrate
 * and work, the ErrorHandler hears exactly one StrataBoundaryError, and Strata
 * neither retries nor reloads.
 */
export async function checkPreflightIsolation(
  target: RuntimeTarget,
  browser: Browser,
): Promise<boolean> {
  const results: boolean[] = [];

  for (const tamperCase of PREFLIGHT_CASES) {
    section(`${target.name}: browser preflight failure — ${tamperCase.name}`);

    const nodes = hostNodes("B");
    const session = await openSession(browser, `${target.baseUrl}${FAILURES_ROUTE}`, {
      tamper: tamperCase.tamper,
      capture: nodes,
    });
    const { page } = session;

    try {
      await settle(page);
      await page.evaluate(() => {
        window.__strataSentinel = "same document";
      });

      const state = await readState(page);
      const identity = await sameNodes(page, nodes);
      const b1 = await pressOnce(page, "B:1");
      const a1 = await pressOnce(page, "A:1");
      const c3 = await pressOnce(page, "C:3");
      const reported = state.errors.filter(isStrataBoundaryError);

      console.log(`  ErrorHandler: ${JSON.stringify(state.errors).slice(0, 600)}`);
      results.push(
        check(
          "host B entirely inert (0 of 3 hydrated, none constructed, even the valid boundaries); A and C hydrated (3 + 3)",
          hydratedIs(state, { A: 3, B: 0, C: 3 }) &&
            sumOf(state.constructed, keysOf("B")) === 0 &&
            sumOf(state.constructed, [...keysOf("A"), ...keysOf("C")]) === 6,
          JSON.stringify(state),
        ),
        check(
          "host B's SSR DOM remains: same nodes, same positions, text visible",
          identity && (await outputText(page, "B:2")) === "Presses: 0",
        ),
        check(
          "ErrorHandler received exactly one error: a StrataBoundaryError naming the boundary, host and reason",
          state.errors.length === 1 &&
            reported.length === 1 &&
            tamperCase.reports.every((part) => reported[0]?.includes(part)),
          JSON.stringify(state.errors),
        ),
        check(
          "diagnostic is data-safe: no props value or payload fragment in any error",
          tamperCase.never.every(
            (part) => ![...state.errors, ...session.console].some((entry) => entry.includes(part)),
          ) && !state.errors.some((entry) => entry.includes("label")),
        ),
        check(
          "handled, not unhandled: one console.error (Angular's ErrorHandler), no page error, no unhandled rejection",
          session.console.length === 1 &&
            session.console[0]?.includes("StrataBoundaryError") === true &&
            session.pageErrors.length === 0,
          JSON.stringify([session.console, session.pageErrors]),
        ),
        check(
          "interaction: B inert; A:1 and C:3 each one click, one effect",
          b1 === "Presses: 0" && a1 === "Presses: 1" && c3 === "Presses: 1",
          JSON.stringify([b1, a1, c3]),
        ),
      );

      // No automatic retry: repair the markup, wait, nothing happens.
      await page.evaluate(() => {
        for (const n of ["1", "2", "3"]) {
          const host = document.querySelector(
            `failure-host[data-host="B"] failure-island[data-island="${n}"]`,
          );

          host?.setAttribute("data-strata-protocol", "1");
          host?.setAttribute("data-strata-props", '{"label":"' + n + '","start":0}');
        }
      });
      await page.waitForTimeout(2_000);

      const later = await readState(page);

      results.push(
        check(
          "no automatic retry (markup repaired, 2 s later B is still inert and nothing more was reported)",
          later.hydrated["B"] === 0 && later.errors.length === 1,
          JSON.stringify(later),
        ),
        check(
          "no reload, no CSR replacement (one document request, same realm)",
          session.documents.length === 1 &&
            (await page.evaluate(() => window.__strataSentinel)) === "same document",
        ),
      );

      // Leaving the page destroys the healthy hosts and the failed one without a further report.
      await page.getByRole("link", { name: "Leave (router)" }).click();
      await page
        .waitForFunction(
          () => document.querySelector("app-server-component-navigation-page") !== null,
          undefined,
          {
            timeout: 10_000,
          },
        )
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const left = await readState(page);

      results.push(
        check(
          "destroy after a failed host: no exception, the six live islands destroyed once, no attached view left, no duplicate report",
          left.errors.length === 1 &&
            session.pageErrors.length === 0 &&
            [...keysOf("A"), ...keysOf("C")].every((key) => left.destroyed[key] === 1) &&
            sumOf(left.destroyed, keysOf("B")) === 0 &&
            left.views === state.views - 6,
          JSON.stringify({ state: state.views, left }),
        ),
      );
    } finally {
      await page.close();
    }

    // A new document is a new lifecycle: one fresh attempt, one report, nothing carried over.
    const again = await openSession(browser, `${target.baseUrl}${FAILURES_ROUTE}`, {
      tamper: tamperCase.tamper,
    });

    try {
      await settle(again.page);

      const fresh = await readState(again.page);

      results.push(
        check(
          "re-entry through a new document is a fresh lifecycle: one attempt, one report (not two), A and C hydrated again",
          fresh.errors.length === 1 && hydratedIs(fresh, { A: 3, B: 0, C: 3 }),
          JSON.stringify(fresh),
        ),
      );
    } finally {
      await again.page.close();
    }
  }

  return all(results);
}

// ---------------------------------------------------------------------------
// D. Hydration commit failure

const COMMIT_CASES = [
  {
    name: "constructor (createComponent) throws on the second island of host B",
    init: () => {
      window.__STRATA_FAILURE__ = { create: "B:2" };
    },
    message: "injected create failure for B:2",
    // B:1 was constructed and attached, B:2 never produced an instance, B:3 was never reached.
    constructed: { "B:1": 1 },
    destroyed: { "B:1": 1 },
  },
  {
    name: "input transform (setInput) throws on the second island of host B",
    init: () => {
      window.__STRATA_FAILURE__ = { input: "B:2" };
    },
    message: "injected input failure for B:2",
    // B:2 was constructed, then setInput threw before attachView: still destroyed.
    constructed: { "B:1": 1, "B:2": 1 },
    destroyed: { "B:1": 1, "B:2": 1 },
  },
] as const;

/**
 * Host B's commit fails after it created island B:1 (and, for setInput, B:2).
 * Every island this commit created is destroyed, its views detached, the SSR
 * host elements are back at their original positions and no marker is set;
 * hosts A and C hydrate and work; the failure is a plain component Error, not
 * a StrataBoundaryError, reported once.
 */
export async function checkCommitFailure(
  target: RuntimeTarget,
  browser: Browser,
  healthyViews: number,
): Promise<boolean> {
  const results: boolean[] = [];

  for (const commit of COMMIT_CASES) {
    section(`${target.name}: hydration commit failure — ${commit.name}`);

    const nodes = hostNodes("B");
    const session = await openSession(browser, `${target.baseUrl}${FAILURES_ROUTE}`, {
      init: commit.init,
      capture: nodes,
    });
    const { page } = session;

    try {
      await settle(page);

      const state = await readState(page);
      const identity = await sameNodes(page, nodes);
      const b1 = await pressOnce(page, "B:1");
      const a1 = await pressOnce(page, "A:1");
      const c3 = await pressOnce(page, "C:3");
      const a1Again = await pressOnce(page, "A:1");

      console.log(`  ErrorHandler: ${JSON.stringify(state.errors)}`);
      results.push(
        check(
          "every island created by host B's commit was destroyed (constructed = destroyed, per island)",
          JSON.stringify(Object.keys(commit.constructed).map((k) => state.constructed[k])) ===
            JSON.stringify(Object.values(commit.constructed)) &&
            JSON.stringify(Object.keys(commit.destroyed).map((k) => state.destroyed[k])) ===
              JSON.stringify(Object.values(commit.destroyed)) &&
            state.constructed["B:3"] === undefined,
          JSON.stringify({ c: state.constructed, d: state.destroyed }),
        ),
        check(
          "no attached view left for host B (viewCount = the nine-island baseline minus B's three)",
          state.views === healthyViews - 3,
          `${state.views} vs ${healthyViews} - 3`,
        ),
        check(
          "no data-strata-hydrated on host B; A and C hydrated (3 + 3)",
          hydratedIs(state, { A: 3, B: 0, C: 3 }),
          JSON.stringify(state.hydrated),
        ),
        check(
          "rollback DOM identity: host B's elements are the same objects, same parent, same next sibling, same SSR text",
          identity && (await outputText(page, "B:1")) === "Presses: 0",
        ),
        check(
          "restored B islands are inert; A and C work (one click, one effect; a second click → 2)",
          b1 === "Presses: 0" &&
            a1 === "Presses: 1" &&
            c3 === "Presses: 1" &&
            a1Again === "Presses: 2",
          JSON.stringify([b1, a1, c3, a1Again]),
        ),
        check(
          "ErrorHandler received exactly one error: the component's own Error, not relabelled a StrataBoundaryError",
          state.errors.length === 1 &&
            state.errors[0]?.startsWith("Error:") === true &&
            state.errors[0].includes(commit.message),
          JSON.stringify(state.errors),
        ),
        check(
          "handled, not unhandled: one console.error, no page error",
          session.console.length === 1 && session.pageErrors.length === 0,
          JSON.stringify([session.console, session.pageErrors]),
        ),
      );

      // No retry on a later change-detection or time, no reload.
      await page.waitForTimeout(2_000);

      const later = await readState(page);

      results.push(
        check(
          "no automatic retry (2 s later: same counters, same single report, one document request)",
          JSON.stringify([later.constructed, later.errors]) ===
            JSON.stringify([state.constructed, state.errors]) && session.documents.length === 1,
        ),
      );

      await page.getByRole("link", { name: "Leave (router)" }).click();
      await page
        .waitForFunction(
          () => document.querySelector("app-server-component-navigation-page") !== null,
          undefined,
          {
            timeout: 10_000,
          },
        )
        .catch(() => undefined);
      await page.waitForTimeout(500);

      const left = await readState(page);

      results.push(
        check(
          "teardown after a failed commit: every constructed island destroyed exactly once, zero views left over the page, no new report",
          KEYS.every((key) => (left.constructed[key] ?? 0) === (left.destroyed[key] ?? 0)) &&
            Object.values(left.destroyed).every((count) => count === 1) &&
            left.views === healthyViews - 9 &&
            left.errors.length === 1 &&
            session.pageErrors.length === 0,
          JSON.stringify(left),
        ),
      );
    } finally {
      await page.close();
    }
  }

  return all(results);
}

// ---------------------------------------------------------------------------
// E. Island error after successful hydration

/**
 * After `data-strata-hydrated` the island is an ordinary Angular component.
 * A click handler that throws goes to the ErrorHandler once per click; Strata
 * does not roll the island back, destroy the host, retry or wrap the handler.
 */
export async function checkPostHydrationError(
  target: RuntimeTarget,
  browser: Browser,
): Promise<boolean> {
  section(`${target.name}: error after successful hydration — A:1's click handler throws`);

  const session = await openSession(browser, `${target.baseUrl}${FAILURES_ROUTE}`, {
    init: () => {
      window.__STRATA_FAILURE__ = { click: "A:1" };
    },
  });
  const { page } = session;

  try {
    await settle(page);

    const before = await readState(page);
    const first = await pressOnce(page, "A:1");
    const afterFirst = await readState(page);
    const second = await pressOnce(page, "A:1");
    const afterSecond = await readState(page);
    const sibling = await pressOnce(page, "A:2");
    const otherHost = await pressOnce(page, "C:3");

    console.log(`  ErrorHandler: ${JSON.stringify(afterSecond.errors)}`);

    return all([
      check(
        "hydration succeeded first: nine hydrated, zero reports",
        hydratedIs(before, { A: 3, B: 3, C: 3 }) && before.errors.length === 0,
        JSON.stringify(before),
      ),
      check(
        "each throwing click is reported to the ErrorHandler once (1 after the first click, 2 after the second)",
        afterFirst.errors.length === 1 &&
          afterSecond.errors.length === 2 &&
          afterSecond.errors.every((entry) => entry.includes("injected click failure for A:1")),
        JSON.stringify(afterSecond.errors),
      ),
      check(
        "Strata did not intervene: still nine hydrated, nothing destroyed, no new island, no retry",
        hydratedIs(afterSecond, { A: 3, B: 3, C: 3 }) &&
          Object.keys(afterSecond.destroyed).length === 0 &&
          KEYS.every((key) => afterSecond.constructed[key] === 1) &&
          afterSecond.views === before.views,
        JSON.stringify(afterSecond),
      ),
      check(
        "the failing island's state did not change; its siblings and other hosts keep working",
        first === "Presses: 0" &&
          second === "Presses: 0" &&
          sibling === "Presses: 1" &&
          otherHost === "Presses: 1",
        JSON.stringify([first, second, sibling, otherHost]),
      ),
      check("no page error (Angular handled the listener error)", session.pageErrors.length === 0),
    ]);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// F. Document navigation into a failing Server Component

/**
 * Healthy origin → plain anchor (a document navigation) → failing document →
 * Back → the same failing document again. Each document is its own JavaScript
 * realm and its own server render; the failure follows the render-failure
 * contract of its mode; the origin comes back usable with every island working
 * once, however the browser restores it (bfcache or reload is characterized).
 */
export async function checkDocumentNavigation(
  target: RuntimeTarget,
  browser: Browser,
): Promise<boolean> {
  section(
    `${target.name}: document navigation into ${failureRoute("constructor")}, Back, re-entry`,
  );

  const destination = failureRoute("constructor");
  const link = `a[href="${destination}"]`;
  const session = await openSession(browser, `${target.baseUrl}${FAILURES_ROUTE}`);
  const { page } = session;
  const serverMarks: number[] = [];

  const reload = async (): Promise<void> => {
    await page.waitForLoadState("load");
    await page.waitForTimeout(1_500);
  };
  const realm = (): Promise<{
    origin: number;
    sentinel: string | undefined;
    type: string | undefined;
    shows: boolean[];
  }> =>
    page.evaluate(() => ({
      origin: performance.timeOrigin,
      sentinel: window.__strataSentinel,
      type: performance.getEntriesByType("navigation")[0]?.type,
      shows: [...(window.__strataPageshows ?? [])],
    }));

  try {
    await settle(page);
    await page.evaluate(() => {
      window.__strataSentinel = "origin realm";
    });

    const originRealm = await realm();
    const originPress = await pressOnce(page, "A:1");

    // 1. Into the failing document.
    serverMarks.push(target.output().length);
    await Promise.all([page.waitForURL(`**${destination}`), page.click(link)]);
    await reload();

    const failing = await realm();
    const failingState = await readState(page);
    const failingDoc = session.documents.find((doc) => doc.path === destination);
    const failingDom = await page.evaluate(() => ({
      hosts: document.querySelectorAll("failure-host").length,
      hydrated: document.querySelectorAll("[data-strata-hydrated]").length,
      component: document.querySelector("failure-scenario")?.innerHTML ?? null,
    }));
    const firstLog = await logSince(target, serverMarks[0] ?? 0, /\[fixture-error-handler\]/);

    console.log(
      `  failing document: status ${failingDoc?.status}, body ${JSON.stringify(bodyOnly(failingDoc?.body ?? "").slice(0, 200))}`,
    );

    // 2. Back.
    serverMarks.push(target.output().length);
    await page.goBack({ waitUntil: "load" });
    await reload();

    const back = await realm();
    const backState = await readState(page);
    const beforeClick = await outputText(page, "A:1");
    const backPress = await pressOnce(page, "A:1");
    const restored =
      (back.shows.at(-1) ?? false)
        ? "bfcache (pageshow persisted)"
        : `new document (${back.type ?? "?"})`;

    console.log(
      `  Back restored the origin as: ${restored}; navigation type ${back.type}; pageshow ${JSON.stringify(back.shows)}`,
    );

    // 3. Re-entry into the failing destination.
    serverMarks.push(target.output().length);
    await Promise.all([page.waitForURL(`**${destination}`), page.click(link)]);
    await reload();

    const reentry = await realm();
    const reentryState = await readState(page);
    const reentryLog = await logSince(target, serverMarks[2] ?? 0, /\[fixture-error-handler\]/);
    const destinationDocs = session.documents.filter((doc) => doc.path === destination);

    return all([
      check(
        "the click was a document navigation: a new document request, a new JavaScript realm, the old page's state gone",
        originPress === "Presses: 1" &&
          failingDoc !== undefined &&
          failing.origin !== originRealm.origin &&
          failing.sentinel === undefined &&
          failing.type === "navigate",
        JSON.stringify([originRealm, failing]),
      ),
      check(
        "pinned: the failing document answers the render-failure contract (HTTP 200, empty outlet, no component markup)",
        failingDoc?.status === 200 &&
          /<router-outlet><\/router-outlet><!----><\/app-root>/.test(bodyOnly(failingDoc.body)) &&
          !failingDoc.body.includes("data-failure-"),
        failingDoc?.body.slice(0, 200),
      ),
      check(
        "the old page's Server Component DOM and islands did not survive (no host, no hydrated marker, no island of the old realm)",
        failingDom.hosts === 0 &&
          failingDom.hydrated === 0 &&
          failingDom.component === "" &&
          Object.keys(failingState.constructed).length === 0,
        JSON.stringify([failingDom, failingState]),
      ),
      check(
        "one server-side ErrorHandler report for the failing document",
        handled(firstLog).length === 1,
        firstLog.slice(0, 300),
      ),
      check(
        "Back: the origin is usable (nine hydrated, constructed once each, zero reports) and one click is one effect",
        hydratedIs(backState, { A: 3, B: 3, C: 3 }) &&
          KEYS.every((key) => backState.constructed[key] === 1) &&
          backState.errors.length === 0 &&
          backPress === `Presses: ${Number(beforeClick?.replace("Presses: ", "")) + 1}` &&
          session.pageErrors.length === 0,
        JSON.stringify([backState, beforeClick, backPress]),
      ),
      check(
        "no stale failed-host state on the origin (no reports, no console errors in the origin)",
        session.console.length === 0,
        session.console.join(" | "),
      ),
      check(
        "re-entry is a new document lifecycle: a second request, another realm, one more server report (not an accumulation), no browser-side leftovers",
        destinationDocs.length === 2 &&
          destinationDocs.every((doc) => doc.status === 200) &&
          reentry.origin !== failing.origin &&
          reentry.sentinel === undefined &&
          handled(reentryLog).length === 1 &&
          Object.keys(reentryState.constructed).length === 0 &&
          reentryState.errors.length === 0,
        JSON.stringify([destinationDocs.length, reentry, reentryLog.slice(0, 200)]),
      ),
    ]);
  } finally {
    await page.close();
  }
}
