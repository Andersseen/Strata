import { SERVER_ONLY, check } from "./harness.ts";
import { DESTINATION, ORIGIN } from "./navigation.ts";
import type { LinkFlow } from "./navigation.ts";

function all(results: readonly boolean[]): boolean {
  return results.every(Boolean);
}

/**
 * Assertions over the StrataDocumentLink / StrataDocumentNavigator flow,
 * shared by the Node production run (navigation.ts) and local workerd
 * (cloudflare.ts) so both runtimes are held to the same contract.
 */
export function checkLinkFlow(link: LinkFlow): boolean {
  const linkRequests = link.session.requests.filter((r) => r.phase === "document link");
  const programmaticRequests = link.session.requests.filter(
    (r) => r.phase === "programmatic document navigation",
  );
  const expectedHref = `${DESTINATION}?product=42&label=a%20b%26c#details`;

  console.log(`link href: ${link.href}`);
  console.log(`link after click: ${JSON.stringify(link.afterClick)}`);
  console.log(`programmatic: ${JSON.stringify(link.programmatic)}`);
  return all([
    check(
      "href is computed from commands, query params and fragment",
      link.href === expectedHref,
      String(link.href),
    ),
    check(
      "href is server-rendered (present in the SSR HTML, encoded)",
      link.ssrOriginHtml.includes(`href="${expectedHref.replaceAll("&", "&amp;")}"`),
    ),
    check(
      "target is left to the author",
      link.newTabTarget === "_blank" && link.newTabHref === DESTINATION,
    ),
    check(
      "a click made a real document request",
      linkRequests.some(
        (r) => r.navigation && r.url === DESTINATION && r.resourceType === "document",
      ),
    ),
    check("sentinel gone: a new JavaScript realm", !link.afterClick.sentinel),
    check(
      "Navigation Timing: the current document is the destination",
      link.afterClick.documentEntry === `${DESTINATION} (navigate)`,
      link.afterClick.documentEntry,
    ),
    check(
      "query parameters preserved",
      link.afterClick.search === "?product=42&label=a%20b%26c",
      link.afterClick.search,
    ),
    check("fragment preserved", link.afterClick.hash === "#details", link.afterClick.hash),
    check(
      "new document is server-rendered",
      link.clickDocument.includes("<h1>Product 42</h1>") && link.clickDocument.includes("Count: 0"),
    ),
    check(
      "new document carries no server-only marker",
      SERVER_ONLY.every((marker) => !link.clickDocument.includes(marker)),
    ),
    check(
      "island hydrates once and reuses SSR DOM",
      link.clickHydrated &&
        link.afterClick.hydratedIslands === 1 &&
        link.afterClick.remainingHydrationAnnotations === 0,
    ),
    check(
      "exactly one island created, one server article",
      link.afterClick.islandsCreated === 1 && link.afterClick.articles === 1,
    ),
    check(
      "click → Count: 1 (one handler)",
      link.countAfterClick === "Count: 1",
      String(link.countAfterClick),
    ),
    check(
      "Back shows the origin route",
      link.afterBack.url === ORIGIN &&
        link.afterBack.originHeading &&
        link.afterBack.serverComponentHosts === 0,
    ),
    check(
      "StrataDocumentNavigator made a real document request with query and fragment",
      programmaticRequests.some(
        (r) => r.navigation && r.url === DESTINATION && r.resourceType === "document",
      ) &&
        link.programmatic.search === "?product=43" &&
        link.programmatic.hash === "#details" &&
        !link.programmatic.sentinel,
    ),
    check(
      "programmatic destination is hydrated once",
      link.programmaticHydrated &&
        link.programmatic.islandsCreated === 1 &&
        link.programmatic.hydratedIslands === 1,
    ),
    check(
      "programmatic destination contains server-rendered data",
      link.programmaticDocument.includes("<h1>Product 42</h1>"),
    ),
    check(
      "Back from programmatic navigation shows the origin",
      link.afterBackFromProgrammatic.originHeading,
    ),
    check(
      "Forward returns to a hydrated document",
      link.afterForward.hydratedIslands === 1 && link.afterForward.search === "?product=43",
    ),
    check(
      "Ctrl/Cmd-click opens a new tab natively and leaves this one alone",
      link.modifiedClick.popupUrl === expectedHref &&
        link.modifiedClick.stayed.sentinel &&
        link.modifiedClick.stayed.url === ORIGIN,
      String(link.modifiedClick.popupUrl),
    ),
    check("middle-click (auxclick) is not cancelled by the page", link.middleClickNotPrevented),
    check(
      "target=_blank opens a new tab natively",
      link.targetBlank.popupUrl === DESTINATION,
      String(link.targetBlank.popupUrl),
    ),
    check(
      "no console errors, warnings or page errors",
      link.session.errors.length === 0,
      link.session.errors.join(" | "),
    ),
  ]);
}
