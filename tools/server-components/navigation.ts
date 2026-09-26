import { httpGet } from "../analog/lib/process.ts";

import { observeBrowser } from "./lib/browser.ts";
import {
  MARKERS,
  SERVER_ONLY,
  build,
  check,
  checkBrowserGraph,
  checkServerGraph,
  finish,
  section,
  startProductionServer,
} from "./lib/harness.ts";
import { DESTINATION, ORIGIN, observeNavigation } from "./lib/navigation.ts";
import type { DomSnapshot, RequestRecord, ScriptRecord } from "./lib/navigation.ts";

/**
 * `pnpm test:server-component-navigation`: the server-component navigation
 * PoC (docs/research/server-component-navigation-poc.md), end to end against
 * the Analog fixture's production build.
 *
 *   1. PoC build; browser- and server-graph marker scans
 *   2. production Nitro server: direct-load regression (HTTP SSR + hydration)
 *   3. Chromium: document navigation (anchor), with Back and re-entry
 *   4. Chromium: Angular Router navigation (RouterLink), characterized as measured
 *   5. Chromium: island teardown when the router leaves a hydrated server component
 *   6. runtime scan of every script the browser loaded
 *
 * The router assertions pin the measured limitation (an empty surrogate, no
 * server request); they fail if that behaviour changes.
 */

const TITLE = "server-component navigation PoC";
const stop = (): never => finish(TITLE);

function all(results: readonly boolean[]): boolean {
  return results.every(Boolean);
}

function describe(snapshot: DomSnapshot): string {
  return JSON.stringify(snapshot);
}

function printRequests(requests: readonly RequestRecord[], phase: string): void {
  const inPhase = requests.filter((request) => request.phase === phase);

  console.log(`requests during "${phase}" (${inPhase.length}):`);
  for (const r of inPhase) {
    console.log(
      `  ${r.method} ${r.resourceType} ${r.url}${r.navigation ? " [document navigation]" : ""}${r.carriedServerHtml ? " [server-rendered product]" : ""}`,
    );
  }
}

section("PoC build: server component graph split");
build("PoC", {}, stop);
checkBrowserGraph();
checkServerGraph();

const server = await startProductionServer();
const verdict = { direct: false, document: false, routerNegative: false, teardown: false };
const scripts: ScriptRecord[] = [];

try {
  const { baseUrl } = server;

  // 2. Direct load must stay exactly as PR #23 left it.
  section(`Direct-load regression: GET ${DESTINATION}`);

  const html = (await httpGet(`${baseUrl}${DESTINATION}`)).body;
  const direct = await observeBrowser(`${baseUrl}${DESTINATION}`);

  scripts.push(...direct.scripts);
  verdict.direct = all([
    check("SSR HTML contains <h1>Product 42</h1>", html.includes("<h1>Product 42</h1>")),
    check("SSR HTML contains Count: 0", html.includes("Count: 0")),
    check(
      "SSR HTML carries no server-only marker",
      SERVER_ONLY.every((marker) => !html.includes(marker)),
    ),
    check("child boundary hydrates", direct.hydratedWithinTimeout),
    check(
      "hydration reused the SSR DOM (node identity)",
      Object.values(direct.sameNodes).every(Boolean),
      JSON.stringify(direct.sameNodes),
    ),
    check("no [ngh] left", direct.remainingHydrationAnnotations === 0),
    check(
      "click → Count: 1",
      direct.countAfterClick === "Count: 1",
      String(direct.countAfterClick),
    ),
    check("no console errors", direct.errors.length === 0, direct.errors.join(" | ")),
  ]);

  const seen = await observeNavigation(baseUrl);
  const doc = seen.document;
  const router = seen.router;
  const teardown = seen.teardown;

  for (const flow of [doc, router, teardown]) scripts.push(...flow.session.scripts);

  // 3. Document navigation.
  section(`Document navigation: ${ORIGIN} → <a href="${DESTINATION}">`);

  const docRequests = doc.session.requests.filter((r) => r.phase === "document navigation");
  const docHtml = doc.session.documents.get(DESTINATION) ?? "";
  const nav = doc.afterNavigation;

  printRequests(doc.session.requests, "document navigation");
  console.log(`after navigation: ${describe(nav)}`);
  verdict.document = all([
    check(
      "a document request for the destination was made",
      docRequests.some(
        (r) => r.navigation && r.url === DESTINATION && r.resourceType === "document",
      ),
    ),
    check("sentinel gone: a new JavaScript realm", !nav.sentinel),
    check(
      "Navigation Timing: the current document is the destination",
      nav.documentEntry === `${DESTINATION} (navigate)`,
      nav.documentEntry,
    ),
    check(
      "router events restart in the new document",
      nav.routerEvents[0] === `start ${DESTINATION}`,
      nav.routerEvents.join(", "),
    ),
    check(
      "new document HTML contains <h1>Product 42</h1>",
      docHtml.includes("<h1>Product 42</h1>"),
    ),
    check(
      "new document HTML contains Server rendered product",
      docHtml.includes("<p>Server rendered product</p>"),
    ),
    check("new document HTML contains Count: 0", docHtml.includes("Count: 0")),
    check(
      "new document HTML carries no server-only marker",
      SERVER_ONLY.every((marker) => !docHtml.includes(marker)),
    ),
    check("child boundary hydrates", doc.islandHydrated),
    check("no [ngh] left", nav.remainingHydrationAnnotations === 0),
    check("one server article, one island", nav.articles === 1 && nav.hydratedIslands === 1),
    check("Count: 0 after hydration", nav.count === "Count: 0", String(nav.count)),
    check("click → Count: 1", doc.countAfterClick === "Count: 1", String(doc.countAfterClick)),
  ]);

  section("Document navigation: Back");

  const back = doc.afterBack;

  console.log(`after Back: ${describe(back)}`);
  console.log(
    `origin ${back.sentinel ? "restored from the back/forward cache (sentinel present)" : "reloaded as a new document (sentinel absent)"}, entry ${back.documentEntry}`,
  );
  verdict.document &&= all([
    check("origin page shown", back.url === ORIGIN && back.originHeading),
    check(
      "no server component, island or product left",
      back.serverComponentHosts === 0 && back.addToCartHosts === 0 && !back.productText,
    ),
  ]);

  section("Document navigation: re-entry (origin → destination → origin → destination)");

  const again = doc.reentry;

  console.log(`after re-entry: ${describe(again)}`);
  verdict.document &&= all([
    check("child boundary hydrates again", doc.reentryHydrated),
    check(
      "new realm again",
      !again.sentinel && again.documentEntry === `${DESTINATION} (navigate)`,
    ),
    check(
      "exactly one island created in this document",
      again.hydratedIslands === 1 && again.islandsCreated === 1 && again.addToCartHosts === 1,
      `${again.hydratedIslands} hydrated, ${again.islandsCreated} created`,
    ),
    check("Count: 0 on entry", again.count === "Count: 0", String(again.count)),
    check(
      "one increment per click (Count: 1, then Count: 2)",
      doc.reentryCounts[0] === "Count: 1" && doc.reentryCounts[1] === "Count: 2",
      doc.reentryCounts.join(" → "),
    ),
    check(
      "no console errors, warnings or page errors across the flow",
      doc.session.errors.length === 0,
      doc.session.errors.join(" | "),
    ),
  ]);

  // 4. Angular Router navigation, as measured.
  section(`Angular Router navigation: ${ORIGIN} → routerLink="${DESTINATION}" (characterization)`);

  const before = router.beforeNavigation;
  const spa = router.afterNavigation;
  const routerRequests = router.session.requests.filter((r) => r.phase === "router navigation");

  printRequests(router.session.requests, "router navigation");
  console.log(`before: ${describe(before)}`);
  console.log(`after:  ${describe(spa)}`);
  verdict.routerNegative = all([
    check("route URL changed", spa.url === DESTINATION, spa.url),
    check(
      "router navigation completed (NavigationEnd)",
      spa.routerEvents.includes(`end ${DESTINATION}`),
      spa.routerEvents.join(", "),
    ),
    check("sentinel kept: no document reload", spa.sentinel),
    check(
      "Navigation Timing: still the origin document",
      spa.documentEntry === `${ORIGIN} (navigate)`,
      spa.documentEntry,
    ),
    check(
      "no document request",
      routerRequests.every((r) => !r.navigation && r.resourceType !== "document"),
    ),
    check(
      "the destination's client route chunk was downloaded",
      routerRequests.some((r) => /^\/assets\/server-component\.page-[\w-]+\.js$/.test(r.url)),
    ),
    check(
      "no request to Nitro other than static scripts (no fetch/xhr, no server payload)",
      routerRequests.every((r) => r.resourceType === "script" && r.url.startsWith("/assets/")),
    ),
    check(
      "no response carried server-rendered product data",
      routerRequests.every((r) => !r.carriedServerHtml),
    ),
    check("origin content is gone", !spa.originHeading),
    check(
      "server component host rendered by the surrogate",
      spa.serverComponentHosts === 1,
      String(spa.serverComponentHosts),
    ),
    check(
      "measured limitation: the host is empty (no article, no Product 42, no AddToCart)",
      spa.serverComponentChildren === 0 &&
        spa.articles === 0 &&
        !spa.productText &&
        spa.addToCartHosts === 0,
      describe(spa),
    ),
    check(
      "no island created, nothing to hydrate",
      spa.islandsCreated === 0 &&
        spa.hydratedIslands === 0 &&
        spa.remainingHydrationAnnotations === 0,
    ),
    check(
      "no console errors, warnings or page errors (the failure is silent)",
      router.session.errors.length === 0,
      router.session.errors.join(" | "),
    ),
  ]);

  section("Angular Router navigation: Back and re-entry");

  const routerBack = router.afterBack;
  const routerAgain = router.reentry;

  console.log(`after Back:     ${describe(routerBack)}`);
  console.log(`after re-entry: ${describe(routerAgain)}`);
  verdict.routerNegative &&= all([
    check(
      "Back is a router navigation in the same realm, origin shown",
      routerBack.sentinel && routerBack.originHeading && routerBack.serverComponentHosts === 0,
    ),
    check(
      "re-entry: same empty host, still no island",
      routerAgain.sentinel &&
        routerAgain.serverComponentHosts === 1 &&
        routerAgain.serverComponentChildren === 0 &&
        routerAgain.islandsCreated === 0,
    ),
  ]);

  // 5. Island teardown.
  section(`Island lifecycle: direct load ${DESTINATION} → routerLink away → routerLink back`);

  const leave = teardown.afterLeave;
  const reentered = teardown.afterRouterReentry;

  printRequests(teardown.session.requests, "router re-entry after teardown");
  console.log(`loaded:         ${describe(teardown.loaded)}`);
  console.log(`after leave:    ${describe(leave)}`);
  console.log(`after re-entry: ${describe(reentered)}`);
  verdict.teardown = all([
    check(
      "one island hydrated on load",
      teardown.loaded.islandsCreated === 1 && teardown.loaded.hydratedIslands === 1,
    ),
    check(
      "click → Count: 1",
      teardown.countAfterClick === "Count: 1",
      String(teardown.countAfterClick),
    ),
    check("leave was a router navigation (same realm)", leave.sentinel && leave.originHeading),
    check(
      "DestroyRef destroyed the island ComponentRef (created 1, destroyed 1)",
      leave.islandsCreated === 1 && leave.islandsDestroyed === 1,
      `${leave.islandsCreated} created, ${leave.islandsDestroyed} destroyed`,
    ),
    check(
      "no orphan server DOM or island left",
      leave.serverComponentHosts === 0 && leave.addToCartHosts === 0 && !leave.productText,
    ),
    check(
      "router re-entry: empty surrogate, no new or duplicate island",
      reentered.serverComponentChildren === 0 &&
        reentered.islandsCreated === 1 &&
        reentered.islandsDestroyed === 1 &&
        reentered.addToCartHosts === 0,
    ),
    check(
      "no console errors, warnings or page errors",
      teardown.session.errors.length === 0,
      teardown.session.errors.join(" | "),
    ),
  ]);
} finally {
  await server.stop();
}

// 6. Runtime graph: what the browser actually executed, across every flow.
section("Scripts loaded at runtime (all flows)");

const loaded = [...new Set(scripts.map((script) => new URL(script.url).pathname))];
const runtimeLeaks = SERVER_ONLY.filter((marker) =>
  scripts.some((script) => script.body.includes(marker)),
);

console.log(`loaded scripts: ${loaded.join(", ")}`);
check(
  "no loaded script contains a server-only marker",
  runtimeLeaks.length === 0,
  runtimeLeaks.join(", "),
);
check(
  "loaded scripts contain the client component",
  scripts.some((script) => script.body.includes(MARKERS.client)),
);

section("Classification (as measured)");
console.log(`direct load                 ${verdict.direct ? "✓" : "✗"}`);
console.log(`document navigation         ${verdict.document ? "GO" : "NO-GO"}`);
console.log(
  `router navigation           ${verdict.routerNegative ? "NO-GO (empty surrogate, no server subtree; limitation reproduced)" : "UNEXPECTED: differs from the recorded limitation"}`,
);
console.log(`island teardown on leave    ${verdict.teardown ? "✓" : "✗"}`);

stop();
