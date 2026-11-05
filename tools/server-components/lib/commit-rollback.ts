import { chromium } from "playwright";

import { check } from "./harness.ts";

/**
 * Hydration COMMIT failure through the installed `@strata-sc/server-components` tarball
 * (docs/research/m3-m4-contract-stabilization.md). The packed consumer already proves a
 * preflight refusal (129 boundaries); the commit-phase rollback, sibling-host isolation and the
 * single ErrorHandler report were only proven on the workspace fixture
 * (`pnpm test:server-component-failures`).
 *
 * `/pair` renders two hosts of the same Server Component. The document is rewritten in the
 * browser so ONLY host 2's `legacy-counter` carries `start: -1`. That value passes Strata's
 * preflight (a finite number) and makes the consumer's input transform throw inside `setInput`
 * on host 2's FOURTH island, after its first three islands were created and attached. Host 2
 * must roll back to its server-rendered DOM, inert; host 1 must commit and stay interactive.
 */

const BAD_PROPS = 'data-strata-props="{&quot;start&quot;:-1}"';
const GOOD_PROPS = 'data-strata-props="{&quot;start&quot;:0}"';

export function poisonSecondHost(html: string): string {
  const first = html.indexOf("<product-details");
  const second = html.indexOf("<product-details", first + 1);
  const end = html.indexOf("</product-details>", second);
  if (first < 0 || second < 0 || end < 0) {
    throw new Error("/pair does not render two product-details hosts");
  }
  const host = html.slice(second, end);
  if (host.split(GOOD_PROPS).length !== 2) {
    throw new Error("host 2 does not carry exactly one legacy-counter boundary with start 0");
  }

  return html.slice(0, second) + host.replace(GOOD_PROPS, BAD_PROPS) + html.slice(end);
}

interface Observation {
  readonly hostSelector: string;
  readonly outcome: string;
  readonly discoveredBoundaries: number;
  readonly committedBoundaries: number;
  readonly failureCategory?: string;
  readonly buildMismatch: boolean;
}

interface RecordedError {
  readonly name: string;
  readonly category: string | null;
  readonly message: string;
}

export interface CommitRollbackResult {
  readonly observations: readonly Observation[];
  readonly errors: readonly RecordedError[];
  readonly consoleErrors: readonly string[];
  readonly hydratedPerHost: readonly number[];
  readonly host2Identity: boolean;
  readonly host2TextBefore: readonly string[];
  readonly host2TextAfter: readonly string[];
  readonly host1Counts: readonly string[];
  readonly host1Legacy: string | null;
  readonly host2CountAfterClick: string | null;
}

/** The DOM this module's `page.evaluate` callbacks touch (tools compile without the DOM lib). */
interface DomNode {
  readonly isConnected: boolean;
  readonly parentNode: DomNode | null;
  readonly nextSibling: DomNode | null;
  readonly firstChild: DomNode | null;
  readonly textContent: string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomNode> & Iterable<DomNode>;
  contains(node: DomNode): boolean;
}

declare const document: {
  querySelectorAll(selector: string): ArrayLike<DomNode> & Iterable<DomNode>;
};
declare const window: {
  __rollbackNodes?: {
    readonly element: DomNode;
    readonly parent: DomNode | null;
    readonly next: DomNode | null;
  }[];
  __strataErrors?: RecordedError[];
  __STRATA_HYDRATION_OBSERVATIONS__?: Observation[];
};

export async function observeCommitRollback(pairUrl: string): Promise<CommitRollbackResult> {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));

    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleErrors.push(`console.${message.type()}: ${message.text().slice(0, 200)}`);
      }
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.route(pairUrl, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: poisonSecondHost(await response.text()) });
    });
    // Hold the scripts until host 2's server-rendered nodes and positions are recorded.
    await page.route("**/*.js", async (route) => {
      await released;
      await route.continue();
    });

    await page.goto(pairUrl, { waitUntil: "commit" });
    await page.waitForSelector("product-details:nth-of-type(2) legacy-counter output", {
      state: "attached",
    });
    const host2TextBefore = await page.evaluate(() => {
      const host = document.querySelectorAll("product-details")[1]!;
      const nodes = [
        host.querySelector("article"),
        ...host.querySelectorAll("[data-strata-client]"),
        host.querySelector("add-to-cart button[data-product-id]"),
        host.querySelector("legacy-counter button"),
        host.querySelector("add-to-cart output:not(#stock)")?.firstChild ?? null,
        host.querySelector("legacy-counter output")?.firstChild ?? null,
      ].filter((node): node is DomNode => node !== null);
      window.__rollbackNodes = nodes.map((element) => ({
        element,
        parent: element.parentNode,
        next: element.nextSibling,
      }));
      return [
        host.querySelector("add-to-cart output:not(#stock)")?.textContent ?? "",
        host.querySelector("legacy-counter output")?.textContent ?? "",
      ];
    });

    release();
    await page.waitForFunction(
      () => (window.__STRATA_HYDRATION_OBSERVATIONS__?.length ?? 0) >= 2,
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForLoadState("load");

    const settled = await page.evaluate(() => {
      const hosts = [...document.querySelectorAll("product-details")];
      const host2 = hosts[1]!;
      return {
        observations: (window.__STRATA_HYDRATION_OBSERVATIONS__ ?? []).map((event) => ({
          hostSelector: event.hostSelector,
          outcome: event.outcome,
          discoveredBoundaries: event.discoveredBoundaries,
          committedBoundaries: event.committedBoundaries,
          ...(event.failureCategory === undefined
            ? {}
            : { failureCategory: event.failureCategory }),
          buildMismatch: event.buildMismatch,
        })),
        errors: [...(window.__strataErrors ?? [])],
        hydratedPerHost: hosts.map(
          (host) => host.querySelectorAll("[data-strata-hydrated]").length,
        ),
        host2Identity:
          (window.__rollbackNodes?.length ?? 0) >= 8 &&
          (window.__rollbackNodes ?? []).every(
            ({ element, parent, next }) =>
              element.isConnected &&
              element.parentNode === parent &&
              element.nextSibling === next &&
              host2.contains(element),
          ),
        host2TextAfter: [
          host2.querySelector("add-to-cart output:not(#stock)")?.textContent ?? "",
          host2.querySelector("legacy-counter output")?.textContent ?? "",
        ],
      };
    });

    const host = (index: number) => page.locator("product-details").nth(index);
    const count = (index: number) => host(index).locator("add-to-cart output:not(#stock)");
    const press = async (index: number) =>
      host(index).locator("add-to-cart button[data-product-id]").click();
    const host1Counts: string[] = [];

    await press(0);
    await page
      .waitForFunction(
        () =>
          document
            .querySelectorAll("product-details")[0]
            ?.querySelector("add-to-cart output:not(#stock)")?.textContent === "Count: 1",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    host1Counts.push((await count(0).textContent()) ?? "");
    // A click on the rolled-back host, then one more on host 1: once host 1 shows Count: 2 the
    // earlier host-2 click has been dispatched too, so its unchanged count is not a race.
    await press(1);
    await press(0);
    await page
      .waitForFunction(
        () =>
          document
            .querySelectorAll("product-details")[0]
            ?.querySelector("add-to-cart output:not(#stock)")?.textContent === "Count: 2",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    host1Counts.push((await count(0).textContent()) ?? "");
    await host(0).locator("legacy-counter button").click();
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll("product-details")[0]?.querySelector("legacy-counter output")
            ?.textContent === "Legacy count: 1",
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);

    return {
      ...settled,
      consoleErrors,
      host2TextBefore,
      host1Counts,
      host1Legacy: await host(0).locator("legacy-counter output").textContent(),
      host2CountAfterClick: await count(1).textContent(),
    };
  } finally {
    await browser.close();
  }
}

/** The contract of a failed host commit, asserted for one runtime. */
export function assessCommitRollback(label: string, result: CommitRollbackResult): boolean {
  const committed = result.observations.filter((event) => event.outcome === "committed");
  const failed = result.observations.filter((event) => event.outcome === "commit-failed");
  const detail = JSON.stringify(result).slice(0, 1_500);

  return [
    check(
      `${label}: one terminal observation per host — host 1 committed 4/4, host 2 commit-failed 0/4, unclassified, no mismatch`,
      result.observations.length === 2 &&
        committed.length === 1 &&
        committed[0]?.discoveredBoundaries === 4 &&
        committed[0].committedBoundaries === 4 &&
        failed.length === 1 &&
        failed[0]?.discoveredBoundaries === 4 &&
        failed[0].committedBoundaries === 0 &&
        failed[0].failureCategory === undefined &&
        failed[0].buildMismatch === false,
      detail,
    ),
    check(
      `${label}: the ErrorHandler receives the component's own Error exactly once (not a StrataBoundaryError)`,
      result.errors.length === 1 &&
        result.errors[0]?.name === "Error" &&
        result.errors[0].category === null &&
        result.errors[0].message.includes("legacy-counter start must not be negative") &&
        result.consoleErrors.length === 1,
      detail,
    ),
    check(
      `${label}: host 2 rolled back — no hydrated marker, every server-rendered node kept identity, parent and position, SSR text intact`,
      result.hydratedPerHost[0] === 4 &&
        result.hydratedPerHost[1] === 0 &&
        result.host2Identity &&
        JSON.stringify(result.host2TextAfter) === JSON.stringify(result.host2TextBefore) &&
        JSON.stringify(result.host2TextBefore) === JSON.stringify(["Count: 0", "Legacy count: 0"]),
      detail,
    ),
    check(
      `${label}: host 1 stays interactive (one click, one increment) while host 2 stays inert`,
      JSON.stringify(result.host1Counts) === JSON.stringify(["Count: 1", "Count: 2"]) &&
        result.host1Legacy === "Legacy count: 1" &&
        result.host2CountAfterClick === "Count: 0",
      detail,
    ),
  ].every(Boolean);
}
