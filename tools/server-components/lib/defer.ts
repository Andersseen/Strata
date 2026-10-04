import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

import { httpGet } from "../../analog/lib/process.ts";
import { listFiles } from "../../analog/lib/scan.ts";
import { run } from "../../consumer/lib/exec.ts";

import {
  MARKERS,
  check,
  dirGraph,
  distDir,
  fixtureDir,
  graphFilesWith,
  section,
} from "./harness.ts";
import type { OutputGraph } from "./harness.ts";
import { dynamicSpecifiersOf, moduleGraph } from "./module-graph.ts";

/**
 * Server Components + Angular `@defer` / incremental hydration
 * (docs/research/server-component-defer-poc.md), against the Analog
 * fixture's `/server-component-defer` route:
 *
 *   DeferShowcaseServerComponent        server-owned (browser ✗)
 *     → DeferServerChildComponent       ordinary, server-owned (browser ✗)
 *       → <defer-interaction-panel [strataClient]>   client island (browser ✓)
 *           @defer (on interaction; hydrate on interaction) → interaction widget (lazy chunk)
 *       → spacer (2400px)
 *       → <defer-viewport-panel [strataClient]>      client island (browser ✓)
 *           @defer (on viewport; hydrate on viewport)   → viewport widget (lazy chunk)
 *
 * Strata hydrates the two island roots (protocol v1); Angular owns each
 * `@defer` block inside them. Shared by `pnpm test:server-component-defer`
 * (Node) and `pnpm test:server-components:cloudflare` (workerd).
 */

export const DEFER_ROUTE = "/server-component-defer";

export const DEFER_MARKERS = {
  serverParent: MARKERS.deferServerParent,
  serverChild: MARKERS.deferServerChild,
  panel: "STRATA_DEFER_CLIENT_PANEL_MARKER",
  interactionWidget: "STRATA_DEFER_INTERACTION_WIDGET_MARKER",
  viewportWidget: "STRATA_DEFER_VIEWPORT_WIDGET_MARKER",
} as const;

const SERVER_OWNED = [DEFER_MARKERS.serverParent, DEFER_MARKERS.serverChild] as const;
const DEFERRED = [DEFER_MARKERS.interactionWidget, DEFER_MARKERS.viewportWidget] as const;
const ISLANDS = ["defer-interaction-panel", "defer-viewport-panel"] as const;
/** Deterministic: the viewport island starts 2400px below the fold. */
const VIEWPORT = { width: 1000, height: 700 } as const;

const all = (results: readonly boolean[]): boolean => results.every(Boolean);

// ---------------------------------------------------------------------------
// Build output

/**
 * Bundle evidence from Vite's client build: the deferred widgets are in the
 * browser graph, but only in chunks the page reaches through a dynamic
 * `import()`, never in the static closure of the entry or of the island's chunk.
 */
export function checkDeferBundle(): boolean {
  section("Bundle: Angular-owned @defer inside client islands");

  const clientDir = join(distDir, "client");
  const indexHtml = readFileSync(join(clientDir, "index.html"), "utf8");
  const entry = indexHtml.match(/<script type="module"[^>]*\ssrc="\/([^"]+)"/)?.[1];
  const client = dirGraph("dist/client", ["client"]);
  const inClient = (marker: string) =>
    graphFilesWith(client, marker).map((file) => file.slice("client/".length));
  const islandChunks = inClient(DEFER_MARKERS.panel);

  if (!check(`client entry found in dist/client/index.html (${entry})`, entry !== undefined)) {
    return false;
  }

  // What the route loads before any trigger: the entry and the island's
  // chunk, with everything they import statically.
  const eager = new Set(
    [entry!, ...islandChunks].flatMap(
      (start) => moduleGraph(clientDir, start, { dynamic: false }).modules,
    ),
  );
  const dynamicTargets = new Map(
    [...eager].flatMap((file) =>
      dynamicSpecifiersOf(readFileSync(join(clientDir, file), "utf8")).map(
        (specifier) => [basename(specifier), file] as const,
      ),
    ),
  );

  console.log(`eager closure (entry + island chunk, static imports): ${[...eager].join(", ")}`);

  const results = [
    check(
      `client island chunk holds ${DEFER_MARKERS.panel} (${islandChunks.join(", ")})`,
      islandChunks.length > 0,
    ),
  ];

  for (const marker of DEFERRED) {
    const files = inClient(marker);
    const eagerHits = files.filter((file) => eager.has(file));
    const lazyFrom = files.map((file) => dynamicTargets.get(basename(file))).filter(Boolean);

    results.push(
      check(`${marker} present in the browser output (${files.join(", ")})`, files.length > 0),
      check(
        `${marker} absent from the eager closure`,
        eagerHits.length === 0,
        eagerHits.join(", "),
      ),
      check(
        `${marker}'s chunk is a dynamic import() of an eager chunk (${lazyFrom.join(", ")})`,
        files.length > 0 && lazyFrom.length === files.length,
      ),
      check(
        `${marker} chunk does not also carry the island (${DEFER_MARKERS.panel})`,
        files.every((file) => !islandChunks.includes(file)),
      ),
    );
  }

  return all(results);
}

/** Server-owned code absent from the browser, deferred code present in the server. */
export function checkDeferGraphs(browser: OutputGraph, server: OutputGraph): boolean {
  section("Graphs: defer fixture markers");

  return all([
    ...SERVER_OWNED.map((marker) => {
      const found = graphFilesWith(browser, marker);

      return check(`${marker} absent from ${browser.label}`, found.length === 0, found.join(", "));
    }),
    ...[DEFER_MARKERS.panel, ...DEFERRED].map((marker) => {
      const found = graphFilesWith(browser, marker);

      return check(`${marker} present in ${browser.label}`, found.length > 0);
    }),
    ...[...SERVER_OWNED, DEFER_MARKERS.panel, ...DEFERRED].map((marker) => {
      const found = graphFilesWith(server, marker);

      return check(`${marker} present in ${server.label} (SSR renders it)`, found.length > 0);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// HTTP SSR

/** The route's SSR HTML, before any browser JavaScript. */
export async function checkDeferSsr(baseUrl: string, runtime: string): Promise<boolean> {
  section(`${runtime}: GET ${DEFER_ROUTE} (SSR, incremental hydration)`);

  const response = await httpGet(`${baseUrl}${DEFER_ROUTE}`);
  const html = response.body;
  const host = (tag: string) => html.match(new RegExp(`<${tag}\\s[^>]*>`))?.[0] ?? "";
  const interactionHost = host("defer-interaction-widget");

  console.log(
    `rendered: ${html.match(/<defer-showcase[\s\S]*<\/defer-showcase>/)?.[0] ?? "(missing)"}`,
  );

  return all([
    check("HTTP 200 text/html", response.status === 200, String(response.status)),
    ...ISLANDS.map((tag) =>
      check(
        `<${tag}> is a protocol v1 boundary with its own ngh annotation`,
        new RegExp(
          `<${tag} data-strata-client="${tag}" data-strata-protocol="1" data-strata-props="[^"]*" ngh="\\d+">`,
        ).test(html),
        host(tag),
      ),
    ),
    check(
      "hydrate on interaction: SSR rendered the main content (widget, Expanded: 0), not the placeholder",
      html.includes("<defer-interaction-widget") &&
        html.includes("Show rollout details") &&
        html.includes("Expanded: 0") &&
        !html.includes("Load rollout details"),
    ),
    check(
      "hydrate on viewport: SSR rendered the main content (widget, Acknowledged: 0), not the placeholder",
      html.includes("<defer-viewport-widget") &&
        html.includes("Acknowledged: 0") &&
        !html.includes("Acknowledgement pending"),
    ),
    check(
      "Angular marked the interaction block dehydrated (ngb) with its interaction jsaction",
      /\bngb="d\d+"/.test(interactionHost) && /jsaction="[^"]*click:/.test(interactionHost),
      interactionHost,
    ),
    check(
      "Angular's event-replay contract is bootstrapped for click",
      /__jsaction_bootstrap\(document\.body,"[^"]+",\[[^\]]*"click"/.test(html),
    ),
    check(
      "SSR HTML carries no server-owned marker",
      SERVER_OWNED.every((marker) => !html.includes(marker)),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Browser

// The tools' tsconfig has no DOM lib. These are the only DOM shapes the
// callbacks below (which run in the page, not in Node) rely on.
interface DomNode {
  readonly localName: string;
  readonly textContent: string | null;
  readonly firstChild: DomNode | null;
  getAttribute(name: string): string | null;
}

declare const document: {
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
};
declare const window: {
  __STRATA_DEFER_PROBE__?: Record<string, number>;
  __STRATA_ISLAND_PROBE__?: { created: number; destroyed: number };
  __strataDeferNodes?: Record<string, DomNode | null>;
};

/** SSR nodes whose identity Angular's incremental hydration must preserve. */
const IDENTITY = {
  interactionHost: "defer-interaction-widget",
  interactionButton: "defer-interaction-widget button",
  interactionOutput: "defer-interaction-widget output",
  viewportHost: "defer-viewport-widget",
  viewportButton: "defer-viewport-widget button",
} as const;

interface PageState {
  readonly probe: Record<string, number>;
  readonly islandsCreated: number;
  readonly hydratedIslands: readonly string[];
  /** Elements still carrying `ngh` (not hydrated by Angular). */
  readonly ngh: readonly string[];
  /** Elements still carrying `ngb` (inside a dehydrated defer block). */
  readonly ngb: readonly string[];
  readonly expanded: string | null;
  readonly acknowledged: string | null;
  /** Per IDENTITY key: the SSR node is still the node in the document. */
  readonly same: Record<string, boolean>;
}

interface Session {
  readonly page: Page;
  readonly errors: string[];
  /** Every script the page loaded, in order, with its body. */
  readonly scripts: { readonly url: string; readonly body: string }[];
  state(): Promise<PageState>;
  /** Paths of loaded scripts whose body contains `marker`. */
  loaded(marker: string): string[];
}

async function openDeferPage(
  browser: Browser,
  url: string,
  tamper?: (html: string) => string,
): Promise<Session> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors: string[] = [];
  const scripts: { url: string; body: string }[] = [];
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
  page.on("response", async (response) => {
    if (response.request().resourceType() === "script") {
      const entry = { url: new URL(response.url()).pathname, body: "" };

      // Recorded synchronously, so the order is the request order.
      scripts.push(entry);
      entry.body = await response.text().catch(() => "");
    }
  });

  if (tamper) {
    await page.route(url, async (route) => {
      const response = await route.fetch();

      await route.fulfill({ response, body: tamper(await response.text()) });
    });
  }

  // Hold the application's JavaScript until the SSR nodes are captured.
  await page.route("**/*.js", async (route) => {
    await released;
    await route.continue();
  });
  await page.goto(url, { waitUntil: "commit" });
  await page.waitForSelector("defer-viewport-panel", { state: "attached" });
  await page.evaluate((identity) => {
    window.__strataDeferNodes = Object.fromEntries(
      Object.entries(identity).map(([key, selector]) => [key, document.querySelector(selector)]),
    );
  }, IDENTITY);
  release();

  return {
    page,
    errors,
    scripts,
    loaded: (marker) =>
      scripts.filter((script) => script.body.includes(marker)).map((script) => script.url),
    state: () =>
      page.evaluate(
        (identity) => ({
          probe: { ...window.__STRATA_DEFER_PROBE__ },
          islandsCreated: window.__STRATA_ISLAND_PROBE__?.created ?? 0,
          hydratedIslands: Array.from(document.querySelectorAll("[data-strata-hydrated]")).map(
            (element) => element.localName,
          ),
          ngh: Array.from(document.querySelectorAll("[ngh]")).map((element) => element.localName),
          ngb: Array.from(document.querySelectorAll("[ngb]")).map((element) => element.localName),
          expanded: document.querySelector("defer-interaction-widget output")?.textContent ?? null,
          acknowledged: document.querySelector("defer-viewport-widget output")?.textContent ?? null,
          same: Object.fromEntries(
            Object.entries(identity).map(([key, selector]) => {
              const ssr = window.__strataDeferNodes?.[key];

              return [key, !!ssr && ssr === document.querySelector(selector)];
            }),
          ),
        }),
        IDENTITY,
      ),
  };
}

const describeState = (state: PageState): string => JSON.stringify(state);

/** Lets late scripts, hydration and replay settle without a fixed sleep being the assertion. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function checkPositive(browser: Browser, baseUrl: string, runtime: string) {
  section(`${runtime}: Chromium — island roots (Strata), deferred subtrees (Angular)`);

  const session = await openDeferPage(browser, `${baseUrl}${DEFER_ROUTE}`);
  const { page } = session;

  try {
    const islandsHydrated = await page
      .waitForFunction(
        (count) => document.querySelectorAll("[data-strata-hydrated]").length === count,
        ISLANDS.length,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);

    await settle(page);

    const before = await session.state();
    const scriptsBefore = session.scripts.length;

    console.log(`before any trigger: ${describeState(before)}`);
    console.log(`scripts before any trigger: ${session.scripts.map((s) => s.url).join(", ")}`);

    const layer1 = all([
      check("Layer 1 (Strata): both island roots hydrate", islandsHydrated),
      check(
        "StrataIslandHost created exactly two islands, each panel constructed once",
        before.islandsCreated === 2 && before.probe["panel"] === 2,
        describeState(before),
      ),
      check(
        "before any trigger: neither deferred widget was constructed",
        before.probe["interactionWidget"] === undefined &&
          before.probe["viewportWidget"] === undefined,
        JSON.stringify(before.probe),
      ),
      ...DEFERRED.map((marker) =>
        check(
          `before any trigger: no loaded script contains ${marker} (lazy chunk not requested)`,
          session.loaded(marker).length === 0,
          session.loaded(marker).join(", "),
        ),
      ),
      check(
        "before any trigger: SSR main content still in place and dehydrated (ngb kept)",
        before.expanded === "Expanded: 0" &&
          before.acknowledged === "Acknowledged: 0" &&
          before.ngb.includes("defer-interaction-widget"),
        describeState(before),
      ),
      check(
        "the island roots consumed their own ngh; only the server-owned child and the two dehydrated widgets keep theirs",
        [...before.ngh].sort().join(",") ===
          "defer-interaction-widget,defer-server-child,defer-viewport-widget",
        before.ngh.join(","),
      ),
    ]);

    // hydrate on interaction + event replay: ONE click hydrates and counts.
    await page.getByRole("button", { name: "Show rollout details" }).click();

    const interactionHydrated = await page
      .waitForFunction(
        () => window.__STRATA_DEFER_PROBE__?.["interactionWidget"] === 1,
        undefined,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);

    await settle(page);

    const afterClick = await session.state();
    const interactionChunks = session.loaded(DEFER_MARKERS.interactionWidget);
    const newScripts = session.scripts.slice(scriptsBefore).map((s) => s.url);

    console.log(`after one click: ${describeState(afterClick)}`);
    console.log(`scripts requested by the click: ${newScripts.join(", ") || "(none)"}`);

    await page.getByRole("button", { name: "Show rollout details" }).click();
    await page
      .waitForFunction(
        () =>
          document.querySelector("defer-interaction-widget output")?.textContent === "Expanded: 2",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    const afterSecondClick = await session.state();

    const interaction = all([
      check("hydrate on interaction: the click hydrated the deferred widget", interactionHydrated),
      check(
        `the click requested the lazy chunk (${interactionChunks.join(", ")})`,
        interactionChunks.length > 0 && interactionChunks.every((url) => newScripts.includes(url)),
        newScripts.join(", "),
      ),
      check(
        "event replay: one click → one effect (Expanded: 1)",
        afterClick.expanded === "Expanded: 1",
        String(afterClick.expanded),
      ),
      check(
        "a second click → Expanded: 2 (ordinary listener after hydration)",
        afterSecondClick.expanded === "Expanded: 2",
        String(afterSecondClick.expanded),
      ),
      check(
        "incremental hydration reused the SSR DOM (widget host, button, output)",
        afterClick.same["interactionHost"] === true &&
          afterClick.same["interactionButton"] === true &&
          afterClick.same["interactionOutput"] === true,
        JSON.stringify(afterClick.same),
      ),
      check(
        "the interaction widget was constructed once; the viewport widget is still untouched",
        afterSecondClick.probe["interactionWidget"] === 1 &&
          afterSecondClick.probe["viewportWidget"] === undefined &&
          session.loaded(DEFER_MARKERS.viewportWidget).length === 0,
        JSON.stringify(afterSecondClick.probe),
      ),
      check("no island was created again", afterSecondClick.islandsCreated === 2),
    ]);

    // hydrate on viewport: below the fold until scrolled.
    const scriptsBeforeScroll = session.scripts.length;

    await page.locator("defer-viewport-panel").scrollIntoViewIfNeeded();

    const viewportHydrated = await page
      .waitForFunction(() => window.__STRATA_DEFER_PROBE__?.["viewportWidget"] === 1, undefined, {
        timeout: 15_000,
      })
      .then(() => true)
      .catch(() => false);

    await settle(page);

    const afterScroll = await session.state();
    const viewportChunks = session.loaded(DEFER_MARKERS.viewportWidget);
    const scrollScripts = session.scripts.slice(scriptsBeforeScroll).map((s) => s.url);

    console.log(`after scrolling into view: ${describeState(afterScroll)}`);
    console.log(`scripts requested by the scroll: ${scrollScripts.join(", ") || "(none)"}`);

    await page.getByRole("button", { name: "Acknowledge" }).click();
    await page
      .waitForFunction(
        () =>
          document.querySelector("defer-viewport-widget output")?.textContent === "Acknowledged: 1",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    const final = await session.state();

    const viewport = all([
      check(
        "hydrate on viewport: scrolling into view hydrated the deferred widget",
        viewportHydrated,
      ),
      check(
        `the scroll requested the lazy chunk (${viewportChunks.join(", ")})`,
        viewportChunks.length > 0 && viewportChunks.every((url) => scrollScripts.includes(url)),
        scrollScripts.join(", "),
      ),
      check(
        "incremental hydration reused the SSR DOM (widget host, button)",
        afterScroll.same["viewportHost"] === true && afterScroll.same["viewportButton"] === true,
        JSON.stringify(afterScroll.same),
      ),
      check(
        "click Acknowledge → Acknowledged: 1",
        final.acknowledged === "Acknowledged: 1",
        String(final.acknowledged),
      ),
      check(
        "every client-owned node hydrated: only the server-owned child keeps ngh, no ngb left",
        final.ngh.join(",") === "defer-server-child" && final.ngb.length === 0,
        describeState(final),
      ),
      check(
        "each widget constructed exactly once, two islands, none destroyed",
        final.probe["interactionWidget"] === 1 &&
          final.probe["viewportWidget"] === 1 &&
          final.probe["panel"] === 2 &&
          final.islandsCreated === 2,
        describeState(final),
      ),
    ]);

    const runtimeLeaks = SERVER_OWNED.filter((marker) => session.loaded(marker).length > 0);
    const clean = all([
      check(
        "scripts the page loaded contain no server-owned marker",
        runtimeLeaks.length === 0,
        runtimeLeaks.join(", "),
      ),
      check(
        "no console errors, warnings or page errors (no NG05xx hydration error)",
        session.errors.length === 0,
        session.errors.join(" | "),
      ),
    ]);

    return { layer1, interaction, viewport, clean };
  } finally {
    await page.close();
  }
}

/**
 * Boundary protocol v1 still gates the island that owns the `@defer`: a
 * tampered protocol version refuses every boundary of the host before any
 * root exists, so Angular never gets a defer block to hydrate and the lazy
 * chunk is never requested, even on interaction.
 */
async function checkProtocolGate(browser: Browser, baseUrl: string, runtime: string) {
  section(`${runtime}: protocol v1 still gates the deferred island (tampered version)`);

  const session = await openDeferPage(browser, `${baseUrl}${DEFER_ROUTE}`, (html) =>
    html.replace(
      /(<defer-interaction-panel [^>]*data-strata-protocol=")1"/,
      (_match, start: string) => `${start}2"`,
    ),
  );
  const { page } = session;

  try {
    await settle(page);
    await page.getByRole("button", { name: "Show rollout details" }).click();
    await page.waitForTimeout(1_000);
    await settle(page);

    const state = await session.state();
    const refused = session.errors.find((error) =>
      error.includes(
        "[strata] Cannot hydrate client boundary <defer-interaction-panel> (boundary 1 of 2 in <defer-showcase>)",
      ),
    );

    console.log(`after a click on the refused island's widget: ${describeState(state)}`);
    console.log(`errors: ${session.errors.join(" | ")}`);

    return all([
      check("the browser preflight refuses the tampered boundary", refused !== undefined),
      check(
        "all-or-none per host: no island root created, none marked hydrated",
        state.islandsCreated === 0 && state.hydratedIslands.length === 0,
        describeState(state),
      ),
      check(
        "the click hydrated nothing and requested no deferred chunk",
        state.probe["interactionWidget"] === undefined &&
          state.expanded === "Expanded: 0" &&
          DEFERRED.every((marker) => session.loaded(marker).length === 0),
        describeState(state),
      ),
      check(
        "the SSR DOM stays in place",
        state.same["interactionButton"] === true && state.same["viewportButton"] === true,
        JSON.stringify(state.same),
      ),
    ]);
  } finally {
    await page.close();
  }
}

export interface DeferBrowserResult {
  readonly layer1: boolean;
  readonly interaction: boolean;
  readonly viewport: boolean;
  readonly clean: boolean;
  readonly protocolGate: boolean | undefined;
}

export async function checkDeferBrowser(
  baseUrl: string,
  { runtime, protocolGate }: { runtime: string; protocolGate: boolean },
): Promise<DeferBrowserResult> {
  const browser = await chromium.launch();

  try {
    const positive = await checkPositive(browser, baseUrl, runtime);

    return {
      ...positive,
      protocolGate: protocolGate ? await checkProtocolGate(browser, baseUrl, runtime) : undefined,
    };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Fail-closed build

/** Unsupported shapes, each written as a temporary Server Component into the fixture. */
const UNSUPPORTED = [
  {
    shape: "ordinary @defer in a server-owned template",
    template: "@defer (on interaction) { <p>Details</p> } @placeholder { <p>Placeholder</p> }",
    message: "no browser code can ever load the main content",
  },
  {
    shape: "[strataClient] below a server-owned hydrate trigger",
    template: `@defer (hydrate on interaction) { <defer-interaction-panel [label]="'x'" [strataClient]="{ label: 'x' }" /> }`,
    message:
      "It contains the client boundary <defer-interaction-panel>. Strata hydrates every client boundary under a Server Component when the page loads",
  },
] as const;

/**
 * The real fixture build fails before bundling when a Server Component's
 * template owns a `@defer` block, naming the file, line and column.
 * Leaves `dist/` empty: run it last.
 */
export function checkDeferFailsClosed(): boolean {
  section("Fail closed: @defer in a server-owned template fails the production build");

  const file = join(fixtureDir, "src", "app", "defer", "defer-unsupported.server-component.ts");
  const results: boolean[] = [];

  for (const { shape, template, message } of UNSUPPORTED) {
    writeFileSync(
      file,
      `import { Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { DeferInteractionPanelComponent } from "./defer-interaction-panel.component";

@ServerComponent()
@Component({
  selector: "defer-unsupported",
  imports: [DeferInteractionPanelComponent, StrataClientBoundary],
  template: \`${template}\`,
})
export class DeferUnsupportedServerComponent {}
`,
    );

    try {
      const result = run("pnpm", ["exec", "vite", "build"], { cwd: fixtureDir });
      const output = `${result.stdout}\n${result.stderr}`;
      const diagnostic = output.match(/^.*@defer block in .*$/m)?.[0] ?? "";

      console.log(`${shape}: ${diagnostic || output.slice(-1_000)}`);
      results.push(
        check(`${shape}: build exits non-zero`, result.status !== 0, String(result.status)),
        check(
          `${shape}: diagnostic names the file, line and column, and the reason`,
          diagnostic.includes(`${file}:10:14: @defer block in server-only component`) &&
            diagnostic.includes(message) &&
            diagnostic.includes(
              "Move the deferred behaviour inside a component marked [strataClient]",
            ),
          diagnostic,
        ),
      );
    } finally {
      rmSync(file, { force: true });
    }
  }

  results.push(
    check(
      "no temporary Server Component left in the fixture",
      !listFiles(join(fixtureDir, "src", "app", "defer")).some((f) => f.includes("unsupported")),
    ),
  );

  return all(results);
}
