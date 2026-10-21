import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import type { Browser, Page } from "playwright";

/** Response headers that say which edge answered; never cookies, tokens or request headers. */
const EDGE_HEADERS = [
  "server",
  "cf-ray",
  "cf-cache-status",
  "age",
  "content-type",
  "content-length",
  "location",
  "cache-control",
];

export const edgeHeaders = (
  headers: readonly (readonly [string, string])[],
): Record<string, string> =>
  Object.fromEntries(headers.filter(([name]) => EDGE_HEADERS.includes(name.toLowerCase())));

/** What a Chromium page was actually served, for a failure message. */
export interface PageDiagnostics {
  /** Every document response: status, URL, which edge answered, and when (ms since open). */
  readonly documents: {
    status: number;
    url: string;
    atMs: number;
    headers: Record<string, string>;
  }[];
  readonly failedRequests: { url: string; resourceType: string; error: string | null }[];
  readonly navigations: string[];
}

/**
 * A page whose document responses, failed requests and navigations are recorded,
 * and which keeps a Playwright trace and a screenshot of a FAILED run under
 * STRATA_SC_DIAGNOSTICS_DIR (nothing is written when it is unset or the run
 * passed). The deployed site is public and the browser sends no credentials, so
 * neither the trace nor the screenshot can carry a secret.
 */
export async function openDiagnosedPage(
  browser: Browser,
  label: string,
): Promise<{
  page: Page;
  diagnostics: PageDiagnostics;
  finish: (passed: boolean) => Promise<void>;
}> {
  const directory = process.env["STRATA_SC_DIAGNOSTICS_DIR"];
  const context = await browser.newContext();
  const page = await context.newPage();
  const opened = performance.now();
  const diagnostics: PageDiagnostics = { documents: [], failedRequests: [], navigations: [] };

  await context.tracing.start({ screenshots: true, snapshots: true });
  page.on("response", (response) => {
    if (response.request().resourceType() !== "document") return;
    void response
      .allHeaders()
      .catch((): Record<string, string> => ({}))
      .then((headers) =>
        diagnostics.documents.push({
          status: response.status(),
          url: response.url(),
          atMs: Math.round(performance.now() - opened),
          headers: edgeHeaders(Object.entries(headers)),
        }),
      );
  });
  page.on("requestfailed", (request) =>
    diagnostics.failedRequests.push({
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText ?? null,
    }),
  );
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) diagnostics.navigations.push(frame.url());
  });

  return {
    page,
    diagnostics,
    finish: async (passed) => {
      const keep = !passed && !!directory;

      if (keep) mkdirSync(directory, { recursive: true });
      if (keep) await page.screenshot({ path: join(directory, `${label}.png`) }).catch(() => {});
      await context.tracing
        .stop(keep ? { path: join(directory, `${label}.trace.zip`) } : undefined)
        .catch(() => {});
      await context.close().catch(() => {});
    },
  };
}

/** What the browser run observed; every field is asserted by run.ts. */
export interface BrowserObservation {
  /** Before any script ran: server HTML parsed, application JavaScript held back. */
  readonly beforeScripts: {
    readonly productVisible: boolean;
    readonly count: string | null;
    readonly childHasHydrationAnnotation: boolean;
    readonly childMarkedHydrated: boolean;
    readonly stock: string | null;
    readonly packageStock: string | null;
    readonly packageEvents: string | null;
    readonly packageAlternateStock: string | null;
    readonly packageAlternateEvents: string | null;
  };
  readonly hydratedWithinTimeout: boolean;
  /** Node identity across hydration: the SSR nodes are the ones Angular now drives. */
  readonly sameNodes: {
    readonly article: boolean;
    readonly heading: boolean;
    readonly button: boolean;
    readonly countText: boolean;
    readonly variantButton: boolean;
    readonly stockText: boolean;
    readonly packageButton?: boolean;
    readonly packageStockText?: boolean;
    readonly packageAlternateButton?: boolean;
  };
  /** `ngh` attributes left in the document: Angular removes each one it hydrates from. */
  readonly remainingHydrationAnnotations: number;
  /** Islands `StrataIslandHost` created (fixture probe), and boundaries marked hydrated. */
  readonly islandsCreated: number;
  readonly hydratedIslands: number;
  readonly productVisible: boolean;
  readonly countAfterHydration: string | null;
  readonly countAfterClick: string | null;
  readonly stockAfterKeyboard: string | null;
  readonly packageStockAfterKeyboard: string | null;
  readonly packageEventsAfterKeyboard: string | null;
  readonly packageAlternateStockAfterKeyboard: string | null;
  readonly packageAlternateEventsAfterKeyboard: string | null;
  readonly selectedVariantAfterKeyboard: string | null;
  readonly variantButtonSurvivedKeyboard: boolean;
  readonly buttonSurvivedClick: boolean;
  readonly errors: readonly string[];
  /** Every script the page actually loaded, with its body, for a runtime graph scan. */
  readonly scripts: readonly { readonly url: string; readonly body: string }[];
}

// The tools' tsconfig has no DOM lib. These are the only DOM shapes the
// callbacks below (which run in the page, not in Node) rely on.
interface DomNode {
  readonly textContent: string | null;
  readonly firstChild: DomNode | null;
  hasAttribute(name: string): boolean;
}

interface SsrNodes {
  article: DomNode | null;
  heading: DomNode | null;
  button: DomNode | null;
  countText: DomNode | null;
  variantButton: DomNode | null;
  stockText: DomNode | null;
  packageButton: DomNode | null;
  packageStockText: DomNode | null;
  packageAlternateButton: DomNode | null;
}

declare const document: {
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): { readonly length: number };
};
declare const window: {
  __strataSsrNodes?: SsrNodes;
  __STRATA_ISLAND_PROBE__?: { created: number; destroyed: number };
};

/**
 * Opens `url` in Chromium with the application's JavaScript held back until the
 * server-rendered nodes are captured, then lets it run, waits for the client
 * boundary to hydrate, and clicks. Proves hydration by DOM identity rather than
 * by text alone, which a client re-render would also satisfy.
 */
export async function observeBrowser(url: string): Promise<BrowserObservation> {
  const browser = await chromium.launch();
  const { page, diagnostics, finish } = await openDiagnosedPage(browser, "hydration");
  let passed = false;

  try {
    const errors: string[] = [];
    const scripts: { url: string; body: string }[] = [];
    let releaseScripts: () => void = () => undefined;
    const scriptsReleased = new Promise<void>((resolve) => {
      releaseScripts = resolve;
    });

    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        errors.push(`console.${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("response", async (response) => {
      if (response.request().resourceType() === "script") {
        scripts.push({ url: response.url(), body: await response.text().catch(() => "") });
      }
    });

    await page.route("**/*.js", async (route) => {
      await scriptsReleased;
      await route.continue();
    });

    const navigation = await page.goto(url, { waitUntil: "commit" });

    try {
      await page.waitForSelector("add-to-cart output", { state: "attached" });
    } catch (error) {
      // Say what Chromium actually received (a CDN challenge, an error page, an empty
      // shell), not just that the selector never appeared.
      const received = {
        title: await page.title().catch(() => null),
        html: await page.content().then(
          (content) => content.slice(0, 600),
          () => null,
        ),
      };

      throw new Error(
        `no "add-to-cart output" in the server-rendered document: ${JSON.stringify({
          requested: url,
          finalUrl: page.url(),
          status: navigation?.status() ?? null,
          contentType: navigation ? await navigation.headerValue("content-type") : null,
          received,
          browserErrors: errors,
          diagnostics,
        })}`,
        { cause: error },
      );
    }

    const beforeScripts = await page.evaluate(() => {
      const child = document.querySelector("add-to-cart");
      const output = document.querySelector("add-to-cart output:not(#stock)");
      const stock = document.querySelector("add-to-cart #stock");

      window.__strataSsrNodes = {
        article: document.querySelector("product-details article"),
        heading: document.querySelector("product-details h1"),
        button: document.querySelector("add-to-cart button"),
        countText: output?.firstChild ?? null,
        variantButton: document.querySelector('add-to-cart [data-variant="white"]'),
        stockText: stock?.firstChild ?? null,
        packageButton: document.querySelector(
          '#package-picker-primary [data-package-variant="white"]',
        ),
        packageStockText:
          document.querySelector("#package-picker-primary [data-package-stock]")?.firstChild ??
          null,
        packageAlternateButton: document.querySelector(
          '#package-picker-alternate [data-package-variant="white"]',
        ),
      };

      return {
        productVisible: document.querySelector("product-details h1")?.textContent === "Product 42",
        count: output?.textContent ?? null,
        childHasHydrationAnnotation: child?.hasAttribute("ngh") ?? false,
        childMarkedHydrated: child?.hasAttribute("data-strata-hydrated") ?? false,
        stock: stock?.textContent ?? null,
        packageStock:
          document.querySelector("#package-picker-primary [data-package-stock]")?.textContent ??
          null,
        packageEvents:
          document.querySelector("#package-picker-primary [data-package-events]")?.textContent ??
          null,
        packageAlternateStock:
          document.querySelector("#package-picker-alternate [data-package-stock]")?.textContent ??
          null,
        packageAlternateEvents:
          document.querySelector("#package-picker-alternate [data-package-events]")?.textContent ??
          null,
      };
    });

    releaseScripts();

    const hydratedWithinTimeout = await page
      .waitForSelector("add-to-cart[data-strata-hydrated]", { state: "attached", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForLoadState("load");

    const identity = await page.evaluate(() => {
      const ssr = window.__strataSsrNodes;

      return {
        sameNodes: {
          article:
            !!ssr?.article && ssr.article === document.querySelector("product-details article"),
          heading: !!ssr?.heading && ssr.heading === document.querySelector("product-details h1"),
          button: !!ssr?.button && ssr.button === document.querySelector("add-to-cart button"),
          countText:
            !!ssr?.countText &&
            ssr.countText === document.querySelector("add-to-cart output:not(#stock)")?.firstChild,
          variantButton:
            !ssr?.variantButton ||
            ssr.variantButton === document.querySelector('add-to-cart [data-variant="white"]'),
          stockText:
            !ssr?.stockText ||
            ssr.stockText === document.querySelector("add-to-cart #stock")?.firstChild,
          ...(ssr?.packageButton
            ? {
                packageButton:
                  ssr.packageButton ===
                  document.querySelector('#package-picker-primary [data-package-variant="white"]'),
                packageStockText:
                  ssr.packageStockText ===
                  document.querySelector("#package-picker-primary [data-package-stock]")
                    ?.firstChild,
                packageAlternateButton:
                  ssr.packageAlternateButton ===
                  document.querySelector(
                    '#package-picker-alternate [data-package-variant="white"]',
                  ),
              }
            : {}),
        },
        remainingHydrationAnnotations: document.querySelectorAll("[ngh]").length,
        islandsCreated: window.__STRATA_ISLAND_PROBE__?.created ?? 0,
        hydratedIslands: document.querySelectorAll("[data-strata-hydrated]").length,
      };
    });

    const productVisible = await page.locator("product-details h1").isVisible();
    const output = page.locator("add-to-cart output:not(#stock)");
    const countAfterHydration = await output.textContent();

    const hasStructuredVariant =
      (await page.locator('add-to-cart [data-variant="white"]').count()) > 0;
    if (hasStructuredVariant) {
      await page.locator('add-to-cart [data-variant="white"]').press("Enter");
      await page.waitForFunction(
        () => document.querySelector("add-to-cart #stock")?.textContent === "In stock: 5",
      );
    }
    const hasPackageVariant =
      (await page.locator('#package-picker-primary [data-package-variant="white"]').count()) > 0;
    if (hasPackageVariant) {
      await page.locator('#package-picker-primary [data-package-variant="white"]').press("Enter");
      await page.waitForFunction(
        () =>
          document.querySelector("#package-picker-primary [data-package-stock]")?.textContent ===
          "Stock: 5",
      );
    }
    const stockAfterKeyboard = hasStructuredVariant
      ? await page.locator("add-to-cart #stock").textContent()
      : null;
    const selectedVariantAfterKeyboard = hasStructuredVariant
      ? await page.locator('add-to-cart [data-variant="white"]').getAttribute("aria-pressed")
      : null;
    const variantButtonSurvivedKeyboard = hasStructuredVariant
      ? await page.evaluate(
          () =>
            window.__strataSsrNodes?.variantButton ===
            document.querySelector('add-to-cart [data-variant="white"]'),
        )
      : false;

    await page.getByRole("button", { name: "Add to cart" }).click();
    await page
      .waitForFunction(
        () => document.querySelector("add-to-cart output")?.textContent === "Count: 1",
        undefined,
        {
          timeout: 5_000,
        },
      )
      .catch(() => undefined);

    const countAfterClick = await output.textContent();
    const buttonSurvivedClick = await page.evaluate(
      () => window.__strataSsrNodes?.button === document.querySelector("add-to-cart button"),
    );

    passed = true;

    return {
      beforeScripts,
      hydratedWithinTimeout,
      ...identity,
      productVisible,
      countAfterHydration,
      countAfterClick,
      stockAfterKeyboard,
      packageStockAfterKeyboard: hasPackageVariant
        ? await page.locator("#package-picker-primary [data-package-stock]").textContent()
        : null,
      packageEventsAfterKeyboard: hasPackageVariant
        ? await page.locator("#package-picker-primary [data-package-events]").textContent()
        : null,
      packageAlternateStockAfterKeyboard: await page
        .locator("#package-picker-alternate [data-package-stock]")
        .textContent()
        .catch(() => null),
      packageAlternateEventsAfterKeyboard: await page
        .locator("#package-picker-alternate [data-package-events]")
        .textContent()
        .catch(() => null),
      selectedVariantAfterKeyboard,
      variantButtonSurvivedKeyboard,
      buttonSurvivedClick,
      errors,
      scripts,
    };
  } finally {
    await finish(passed);
    await browser.close();
  }
}
