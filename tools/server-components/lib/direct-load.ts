import { chromium } from "playwright";

import { httpGet } from "../../analog/lib/process.ts";
import { observeBrowser } from "./browser.ts";
import type { BrowserObservation } from "./browser.ts";
import { MARKERS, SERVER_ONLY, check, section } from "./harness.ts";
import {
  assessHydration,
  assessSsrDocument,
  describeAssessment,
  keepIntegrityRecord,
} from "./ssr-integrity.ts";
import type { SsrExpectation } from "./ssr-integrity.ts";

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

/** A complete fixture document (docs/research/server-component-ssr-integrity-v07.md). */
const FIXTURE_PAGE: SsrExpectation = {
  content: {
    "server heading": "<h1>Product 42</h1>",
    "server paragraph": "<p>Server rendered product</p>",
    "child initial state": "Count: 0",
    "Server Component subtree": "<product-details",
  },
  boundaries: [{ selector: "add-to-cart", protocol: "1" }],
  forbidden: Object.fromEntries(SERVER_ONLY.map((marker) => [marker, marker])),
};

export async function checkDirectLoad(
  baseUrl: string,
  route: string,
  runtime = "Production server",
  serverLog: () => string = () => "",
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
      "SSR HTML annotates the child for hydration (ngh) and marks its boundary (protocol 1)",
      /<add-to-cart data-strata-client="add-to-cart" data-strata-protocol="1" data-strata-props="[^"]*" ngh="\d+">/.test(
        html,
      ),
      html.match(/<add-to-cart[^>]*>/)?.[0] ?? "no <add-to-cart>",
    ),
    check(
      "SSR HTML carries no server-only marker (only data crosses)",
      SERVER_ONLY.every((marker) => !html.includes(marker)),
    ),
    (() => {
      // A 200 is never enough: the document must be complete and the server log clean.
      const assessment = assessSsrDocument(response, serverLog(), FIXTURE_PAGE);

      if (!assessment.ok) {
        keepIntegrityRecord(`direct-load-${runtime}`, {
          runtime,
          route,
          findings: assessment.findings,
          summary: assessment.summary,
        });
      }

      return check(
        "SSR integrity: complete document (not an empty shell), valid boundary, clean server log",
        assessment.ok,
        describeAssessment(assessment),
      );
    })(),
  ].every(Boolean);

  console.log(
    `rendered: ${html.match(/<product-details[\s\S]*<\/product-details>/)?.[0] ?? "(missing)"}`,
  );

  section(`${runtime}: Chromium via Playwright — hydration and interaction`);

  const seen = await observeBrowser(`${baseUrl}${route}`);
  console.log(
    `Strata host observation timing (${runtime}, attempt ms): ${seen.hydrationObservations.map((event) => event.elapsedMs).join(", ")}`,
  );

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
    check(
      "one committed host observation reports the single island",
      seen.hydrationObservations.length === 1 &&
        seen.hydrationObservations[0]?.hostSelector === "product-details" &&
        seen.hydrationObservations[0]?.outcome === "committed" &&
        seen.hydrationObservations[0]?.discoveredBoundaries === 1 &&
        seen.hydrationObservations[0]?.committedBoundaries === 1 &&
        Number.isFinite(seen.hydrationObservations[0]?.elapsedMs),
      JSON.stringify(seen.hydrationObservations),
    ),
    check("Product 42 visible", seen.productVisible),
    check(
      "Count: 0 after hydration",
      seen.countAfterHydration === "Count: 0",
      String(seen.countAfterHydration),
    ),
    (() => {
      const findings = assessHydration(seen);

      return check(
        "hydration integrity: classified clean (islands hydrated over the SSR DOM, no browser error)",
        findings.length === 0,
        findings.map((finding) => `${finding.class}: ${finding.detail}`).join("; "),
      );
    })(),
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

  const emptyHost = await checkEmptyHostObservation(baseUrl, runtime);

  console.log(`loaded scripts: ${loaded.join(", ")}`);

  return { ssr, hydration: hydration && emptyHost, interaction, runtimeGraph, browser: seen };
}

async function checkEmptyHostObservation(baseUrl: string, runtime: string): Promise<boolean> {
  const response = await httpGet(`${baseUrl}/server-component-empty`);
  const html = response.body;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const serverOk =
      response.status === 200 &&
      html.includes("<strata-empty-host") &&
      html.includes("Empty client boundary host");
    check(`${runtime}: empty surrogate is present in SSR HTML`, serverOk);
    await page.goto(`${baseUrl}/server-component-empty`, { waitUntil: "domcontentloaded" });
    const event = await page
      .waitForFunction(
        () =>
          (
            globalThis as unknown as {
              __STRATA_HYDRATION_OBSERVATIONS__?: readonly {
                hostSelector: string;
                outcome: string;
                discoveredBoundaries: number;
                committedBoundaries: number;
              }[];
            }
          ).__STRATA_HYDRATION_OBSERVATIONS__?.[0],
        undefined,
        { timeout: 15_000 },
      )
      .then(
        (handle) =>
          handle.jsonValue() as Promise<{
            hostSelector: string;
            outcome: string;
            discoveredBoundaries: number;
            committedBoundaries: number;
          }>,
      );
    const valid =
      serverOk &&
      event.hostSelector === "strata-empty-host" &&
      event.outcome === "committed" &&
      event.discoveredBoundaries === 0 &&
      event.committedBoundaries === 0;

    return check(
      `${runtime}: empty host reports one committed zero-boundary transaction`,
      valid,
      JSON.stringify(event),
    );
  } finally {
    await page.close();
    await browser.close();
  }
}
