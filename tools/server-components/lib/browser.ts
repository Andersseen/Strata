import { chromium } from "playwright";

/** What the browser run observed; every field is asserted by run.ts. */
export interface BrowserObservation {
  /** Before any script ran: server HTML parsed, application JavaScript held back. */
  readonly beforeScripts: {
    readonly productVisible: boolean;
    readonly count: string | null;
    readonly childHasHydrationAnnotation: boolean;
    readonly childMarkedHydrated: boolean;
  };
  readonly hydratedWithinTimeout: boolean;
  /** Node identity across hydration: the SSR nodes are the ones Angular now drives. */
  readonly sameNodes: {
    readonly article: boolean;
    readonly heading: boolean;
    readonly button: boolean;
    readonly countText: boolean;
  };
  /** `ngh` attributes left in the document: Angular removes each one it hydrates from. */
  readonly remainingHydrationAnnotations: number;
  readonly productVisible: boolean;
  readonly countAfterHydration: string | null;
  readonly countAfterClick: string | null;
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
}

declare const document: {
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): { readonly length: number };
};
declare const window: { __strataSsrNodes?: SsrNodes };

/**
 * Opens `url` in Chromium with the application's JavaScript held back until the
 * server-rendered nodes are captured, then lets it run, waits for the client
 * boundary to hydrate, and clicks. Proves hydration by DOM identity rather than
 * by text alone, which a client re-render would also satisfy.
 */
export async function observeBrowser(url: string): Promise<BrowserObservation> {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
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

    await page.goto(url, { waitUntil: "commit" });
    await page.waitForSelector("add-to-cart output", { state: "attached" });

    const beforeScripts = await page.evaluate(() => {
      const child = document.querySelector("add-to-cart");
      const output = document.querySelector("add-to-cart output");

      window.__strataSsrNodes = {
        article: document.querySelector("product-details article"),
        heading: document.querySelector("product-details h1"),
        button: document.querySelector("add-to-cart button"),
        countText: output?.firstChild ?? null,
      };

      return {
        productVisible: document.querySelector("product-details h1")?.textContent === "Product 42",
        count: output?.textContent ?? null,
        childHasHydrationAnnotation: child?.hasAttribute("ngh") ?? false,
        childMarkedHydrated: child?.hasAttribute("data-strata-hydrated") ?? false,
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
            ssr.countText === document.querySelector("add-to-cart output")?.firstChild,
        },
        remainingHydrationAnnotations: document.querySelectorAll("[ngh]").length,
      };
    });

    const productVisible = await page.getByRole("heading", { name: "Product 42" }).isVisible();
    const output = page.locator("add-to-cart output");
    const countAfterHydration = await output.textContent();

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

    return {
      beforeScripts,
      hydratedWithinTimeout,
      ...identity,
      productVisible,
      countAfterHydration,
      countAfterClick,
      buttonSurvivedClick,
      errors,
      scripts,
    };
  } finally {
    await browser.close();
  }
}
