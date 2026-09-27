import { httpGet } from "../../analog/lib/process.ts";

import { observeBrowser } from "./browser.ts";
import type { BrowserObservation } from "./browser.ts";
import { MARKERS, SERVER_ONLY, check, section } from "./harness.ts";

/**
 * The direct-load contract of the server-component PoC, against whichever
 * server runtime serves `baseUrl` (Nitro `node-server`, or Wrangler's Pages
 * runtime): HTTP SSR of the route, then Chromium hydration by DOM identity,
 * one island, and interaction.
 */

export interface DirectLoadResult {
  /** The HTTP SSR assertions all held. */
  readonly ssr: boolean;
  /** Hydration by DOM identity, exactly one island, no leftover `ngh`. */
  readonly hydration: boolean;
  readonly interaction: boolean;
  /** No server-only marker in any loaded script; the client component was loaded. */
  readonly runtimeGraph: boolean;
  readonly browser: BrowserObservation;
}

export async function checkDirectLoad(
  baseUrl: string,
  route: string,
  runtime = "Production server",
): Promise<DirectLoadResult> {
  section(`${runtime}: GET ${route}`);

  const response = await httpGet(`${baseUrl}${route}`);
  const html = response.body;

  const ssr = [
    check(
      "HTTP 200 text/html",
      response.status === 200 && !!response.contentType?.includes("text/html"),
      `${response.status} ${response.contentType}`,
    ),
    check("SSR HTML contains <h1>Product 42</h1>", html.includes("<h1>Product 42</h1>")),
    check(
      "SSR HTML contains Server rendered product",
      html.includes("<p>Server rendered product</p>"),
    ),
    check("SSR HTML contains the child's initial state (Count: 0)", html.includes("Count: 0")),
    check(
      "SSR HTML contains <product-details> and <add-to-cart>",
      html.includes("<product-details") && html.includes("<add-to-cart"),
    ),
    check(
      "SSR HTML annotates the child for hydration (ngh) and marks its boundary",
      /<add-to-cart data-strata-client="add-to-cart" data-strata-props="[^"]*" ngh="\d+">/.test(
        html,
      ),
      html.match(/<add-to-cart[^>]*>/)?.[0] ?? "no <add-to-cart>",
    ),
    check(
      "SSR HTML carries no server-only marker (only data crosses)",
      SERVER_ONLY.every((marker) => !html.includes(marker)),
    ),
  ].every(Boolean);

  console.log(
    `rendered: ${html.match(/<product-details[\s\S]*<\/product-details>/)?.[0] ?? "(missing)"}`,
  );

  section(`${runtime}: Chromium via Playwright — hydration and interaction`);

  const seen = await observeBrowser(`${baseUrl}${route}`);

  const hydration = [
    check("before scripts: SSR shows Product 42", seen.beforeScripts.productVisible),
    check(
      "before scripts: SSR shows Count: 0",
      seen.beforeScripts.count === "Count: 0",
      String(seen.beforeScripts.count),
    ),
    check(
      "before scripts: child carries its ngh annotation, not yet hydrated",
      seen.beforeScripts.childHasHydrationAnnotation && !seen.beforeScripts.childMarkedHydrated,
    ),
    check("child boundary hydrates", seen.hydratedWithinTimeout),
    check(
      "hydration reused the SSR DOM (same article, h1, button and text nodes)",
      Object.values(seen.sameNodes).every(Boolean),
      JSON.stringify(seen.sameNodes),
    ),
    check(
      "Angular consumed every ngh annotation (no component left unhydrated)",
      seen.remainingHydrationAnnotations === 0,
      `${seen.remainingHydrationAnnotations} left`,
    ),
    check(
      "StrataIslandHost created exactly one island (no duplicate island)",
      seen.islandsCreated === 1 && seen.hydratedIslands === 1,
      `${seen.islandsCreated} created, ${seen.hydratedIslands} hydrated`,
    ),
    check("Product 42 visible", seen.productVisible),
    check(
      "Count: 0 after hydration",
      seen.countAfterHydration === "Count: 0",
      String(seen.countAfterHydration),
    ),
  ].every(Boolean);

  const interaction = [
    check(
      "click Add to cart → Count: 1",
      seen.countAfterClick === "Count: 1",
      String(seen.countAfterClick),
    ),
    check("button is still the SSR node after the click", seen.buttonSurvivedClick),
    check(
      "no console errors, warnings or page errors",
      seen.errors.length === 0,
      seen.errors.join(" | "),
    ),
  ].every(Boolean);

  const loaded = seen.scripts.map((script) => new URL(script.url).pathname);
  const runtimeLeaks = SERVER_ONLY.filter((marker) =>
    seen.scripts.some((script) => script.body.includes(marker)),
  );

  const runtimeGraph = [
    check(
      "scripts the page actually loaded contain no server-only marker",
      runtimeLeaks.length === 0,
      runtimeLeaks.join(", "),
    ),
    check(
      "scripts the page actually loaded contain the client component",
      seen.scripts.some((script) => script.body.includes(MARKERS.client)),
    ),
  ].every(Boolean);

  console.log(`loaded scripts: ${loaded.join(", ")}`);

  return { ssr, hydration, interaction, runtimeGraph, browser: seen };
}
