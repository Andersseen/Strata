import { chromium } from "playwright";

import { check } from "./harness.ts";

/**
 * Browser-time reference matrix of the installed-island qualification. Each case loads `/mixed`
 * (two different Server Components, each with its own installed package island) and changes ONE
 * thing between the server and the browser: the document of the first host, or the browser
 * bundle of `product-details`. The page itself is never edited: what is mutated is stated per case.
 */

// The tools' tsconfig has no DOM lib; these are the only shapes the in-page callbacks touch.
interface DomElement {
  readonly textContent: string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  click(): void;
}
declare const document: {
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
};
declare const window: {
  __strataErrors?: readonly { name: string; category: string | null; message: string }[];
  __strataMismatches?: readonly unknown[];
  __STRATA_HYDRATION_OBSERVATIONS__?: readonly Observation[];
  __snapshot?: readonly DomElement[];
  __snapshotText?: string;
  __rejections?: string[];
  __getterCalls?: number;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: { reason: unknown }) => void,
  ): void;
};

interface Observation {
  readonly hostSelector: string;
  readonly outcome: string;
  readonly discoveredBoundaries: number;
  readonly committedBoundaries: number;
  readonly failureCategory?: string;
  readonly buildMismatch: boolean;
  readonly elapsedMs: number;
}

export const REFUSED_HOST = "product-details";
export const HEALTHY_HOST = "stock-panel";
const CANARY = "STRATA_REFERENCE_ACCESSOR_CANARY";

export interface RuntimeCase {
  readonly name: string;
  /** What exactly differs from the server's output. Printed with the result. */
  readonly mutation: string;
  readonly rewriteDocument?: (html: string) => string;
  /** Rewrites the browser bundle of `product-details` (its generated surrogate chunk). */
  readonly rewriteChunk?: (body: string) => string;
  /** `committed` for the positive controls; `refused` otherwise. */
  readonly expect: "committed" | "refused";
  readonly report?: readonly string[];
  readonly getterNeverCalled?: boolean;
}

const picker = (body: string): RegExpMatchArray | null =>
  body.match(/\{type:([\w$]+),expectedSelector:`acme-product-picker`\}/);

/** Replaces the picker's descriptor; the case fails (not passes) when the descriptor is not found. */
const replaceDescriptor =
  (build: (type: string) => string) =>
  (body: string): string => {
    const match = picker(body);

    if (!match) throw new Error("the picker descriptor was not found in the browser chunk");

    return body.replace(match[0], build(match[1]!));
  };

export const RUNTIME_CASES: readonly RuntimeCase[] = [
  {
    name: "control: unmodified page",
    mutation: "nothing",
    expect: "committed",
  },
  {
    name: "K: the same valid component listed twice",
    mutation: "the picker descriptor is duplicated in the surrogate's reference array",
    rewriteChunk: replaceDescriptor(
      (type) =>
        `{type:${type},expectedSelector:\`acme-product-picker\`},{type:${type},expectedSelector:\`acme-product-picker\`}`,
    ),
    expect: "committed",
  },
  {
    name: "unregistered selector in markup",
    mutation:
      "the first host's first picker boundary is renamed to <acme-unregistered-picker> (element and data-strata-client)",
    rewriteDocument: (html) =>
      html
        .replace("<acme-product-picker ", "<acme-unregistered-picker ")
        .replace(
          'data-strata-client="acme-product-picker"',
          'data-strata-client="acme-unregistered-picker"',
        )
        .replace("</acme-product-picker>", "</acme-unregistered-picker>"),
    expect: "refused",
    report: ["acme-unregistered-picker"],
  },
  {
    name: "B: expected selector differs from the installed component's selector",
    mutation: "the picker descriptor's expectedSelector becomes acme-other-picker",
    rewriteChunk: replaceDescriptor(
      (type) => `{type:${type},expectedSelector:\`acme-other-picker\`}`,
    ),
    expect: "refused",
    report: ["registered for <acme-other-picker>", 'declares selector "acme-product-picker"'],
  },
  {
    name: "C: two distinct components claim one selector",
    mutation:
      "a second descriptor lists an empty subclass of the installed component (same selector, distinct type)",
    rewriteChunk: replaceDescriptor(
      (type) =>
        `{type:${type},expectedSelector:\`acme-product-picker\`},{type:class extends ${type}{},expectedSelector:\`acme-product-picker\`}`,
    ),
    expect: "refused",
    report: ['two different components declare selector "acme-product-picker"'],
  },
  {
    name: "D: a non-component is listed as the picker",
    mutation: "the picker descriptor's type becomes an empty class",
    rewriteChunk: replaceDescriptor(() => "{type:class{},expectedSelector:`acme-product-picker`}"),
    expect: "refused",
    report: ["is not an Angular component"],
  },
  {
    name: "E: component metadata that throws on reflection",
    mutation: "the picker descriptor's type is a class whose ɵcmp getter throws",
    rewriteChunk: replaceDescriptor(
      () =>
        `{type:Object.defineProperty(class{},\`ɵcmp\`,{get(){throw new Error(\`${CANARY}\`)}}),expectedSelector:\`acme-product-picker\`}`,
    ),
    expect: "refused",
    report: ["component metadata that could not be read"],
  },
  {
    name: "F: malformed descriptor (expectedSelector is a number)",
    mutation: "the picker descriptor's expectedSelector becomes 5",
    rewriteChunk: replaceDescriptor((type) => `{type:${type},expectedSelector:5}`),
    expect: "refused",
    report: ["invalid expectedSelector"],
  },
  {
    name: "F: malformed descriptor (no expectedSelector)",
    mutation: "the picker descriptor loses expectedSelector",
    rewriteChunk: replaceDescriptor((type) => `{type:${type}}`),
    expect: "refused",
    report: ["not a valid descriptor"],
  },
  {
    name: "G: throwing expectedSelector accessor is not invoked",
    mutation:
      "the picker descriptor's expectedSelector becomes a getter that throws and counts calls",
    rewriteChunk: replaceDescriptor(
      (type) =>
        `{type:${type},get expectedSelector(){window.__getterCalls=(window.__getterCalls||0)+1;throw new Error(\`${CANARY}\`)}}`,
    ),
    expect: "refused",
    report: ["not a valid descriptor"],
    getterNeverCalled: true,
  },
  {
    name: "H: descriptor with an unexpected extra field",
    mutation: "the picker descriptor gains an `extra` data property",
    rewriteChunk: replaceDescriptor(
      (type) => `{type:${type},expectedSelector:\`acme-product-picker\`,extra:1}`,
    ),
    expect: "refused",
    report: ["not a valid descriptor"],
  },
];

interface Outcome {
  readonly observations: readonly Observation[];
  readonly errors: readonly { name: string; category: string | null; message: string }[];
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly rejections: readonly string[];
  readonly mainFrameNavigations: number;
  readonly mismatches: number;
  readonly sameNodes: boolean;
  readonly sameText: boolean;
  readonly hydratedInRefused: number;
  readonly hydratedInHealthy: number;
  readonly pickerBefore: string | null;
  readonly pickerAfterClick: string | null;
  readonly badgeBefore: string | null;
  readonly badgeAfterClick: string | null;
  readonly getterCalls: number;
  readonly mutated: boolean;
}

async function runCase(baseUrl: string, scenario: RuntimeCase): Promise<Outcome> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let navigations = 0;
  let mutated = scenario.rewriteChunk === undefined;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const url = `${baseUrl}/mixed`;

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleErrors.push(`${message.type()}: ${message.text().split("\n")[0]}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Document navigations only: the router's history.replaceState is not a reload.
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
  });
  await page.addInitScript(() => {
    window.__rejections = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__rejections?.push(String(event.reason));
    });
  });

  try {
    if (scenario.rewriteDocument) {
      const rewrite = scenario.rewriteDocument;

      await page.route(url, async (route) => {
        const response = await route.fetch();

        await route.fulfill({ response, body: rewrite(await response.text()) });
      });
    }

    await page.route("**/*.js", async (route) => {
      await released;

      const { rewriteChunk } = scenario;

      if (
        rewriteChunk &&
        /product-details\.server-component-[^/]*\.js$/.test(route.request().url())
      ) {
        const response = await route.fetch();
        const body = await response.text();

        mutated = true;
        await route.fulfill({
          response,
          body: rewriteChunk(body),
          headers: { ...response.headers(), "content-type": "text/javascript" },
        });

        return;
      }

      await route.continue();
    });

    await page.goto(url, { waitUntil: "commit" });
    await page.waitForSelector(`${HEALTHY_HOST} button`, { state: "attached" });
    await page.evaluate((host) => {
      const refused = document.querySelector(host);

      window.__snapshot = refused ? Array.from(refused.querySelectorAll("*")) : [];
      window.__snapshotText = refused?.textContent ?? "";
    }, REFUSED_HOST);
    release();
    await page.waitForLoadState("load");
    await page.waitForFunction(
      () => (window.__STRATA_HYDRATION_OBSERVATIONS__?.length ?? 0) >= 2,
      undefined,
      { timeout: 20_000 },
    );
    // Long enough for a retry loop or a late duplicate report to show.
    await page.waitForTimeout(1_500);

    const read = (): Promise<Record<string, unknown>> =>
      page.evaluate(
        ({ refused, healthy }) => {
          const text = (selector: string): string | null =>
            document.querySelector(selector)?.textContent?.trim() ?? null;
          const host = document.querySelector(refused);
          const now = host ? Array.from(host.querySelectorAll("*")) : [];
          const before = window.__snapshot ?? [];

          return {
            sameNodes: before.length === now.length && before.every((node, i) => node === now[i]),
            sameText: (host?.textContent ?? "") === window.__snapshotText,
            hydratedInRefused: host?.querySelectorAll("[data-strata-hydrated]").length ?? 0,
            hydratedInHealthy:
              document.querySelector(healthy)?.querySelectorAll("[data-strata-hydrated]").length ??
              0,
            pickerStock: text(`${refused} #package-picker-primary [data-package-stock]`),
            badge: text(`${healthy} [data-package-badge]`),
          };
        },
        { refused: REFUSED_HOST, healthy: HEALTHY_HOST },
      );

    const first = await read();

    await page.evaluate((host) => {
      document
        .querySelector(`${host} #package-picker-primary [data-package-variant="white"]`)
        ?.click();
    }, REFUSED_HOST);
    await page.evaluate((host) => {
      document.querySelector(`${host} [data-package-badge]`)?.click();
    }, HEALTHY_HOST);
    await page.waitForTimeout(600);

    const second = await read();
    const state = await page.evaluate(() => ({
      observations: [...(window.__STRATA_HYDRATION_OBSERVATIONS__ ?? [])],
      errors: [...(window.__strataErrors ?? [])],
      mismatches: window.__strataMismatches?.length ?? 0,
      rejections: [...(window.__rejections ?? [])],
      getterCalls: window.__getterCalls ?? 0,
    }));

    return {
      observations: state.observations,
      errors: state.errors,
      consoleErrors,
      pageErrors,
      rejections: state.rejections,
      mainFrameNavigations: navigations,
      mismatches: state.mismatches,
      sameNodes: second["sameNodes"] === true,
      sameText: second["sameText"] === true,
      hydratedInRefused: Number(second["hydratedInRefused"]),
      hydratedInHealthy: Number(second["hydratedInHealthy"]),
      pickerBefore: first["pickerStock"] as string | null,
      pickerAfterClick: second["pickerStock"] as string | null,
      badgeBefore: first["badge"] as string | null,
      badgeAfterClick: second["badge"] as string | null,
      getterCalls: state.getterCalls,
      mutated,
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/** Runs every case against one running server and returns whether all checks passed. */
export async function checkRuntimeMatrix(
  target: string,
  baseUrl: string,
  cases: readonly RuntimeCase[] = RUNTIME_CASES,
): Promise<boolean> {
  const results: boolean[] = [];

  for (const scenario of cases) {
    const label = `${target} — ${scenario.name}`;
    let outcome: Outcome;

    try {
      outcome = await runCase(baseUrl, scenario);
    } catch (error) {
      results.push(check(`${label}: the case ran`, false, String(error).slice(0, 600)));
      continue;
    }

    const refusedEvent = outcome.observations.find((o) => o.hostSelector === REFUSED_HOST);
    const healthyEvent = outcome.observations.find((o) => o.hostSelector === HEALTHY_HOST);
    const everyText = [
      ...outcome.errors.map((e) => e.message),
      ...outcome.consoleErrors,
      ...outcome.pageErrors,
      JSON.stringify(outcome.observations),
    ].join("\n");

    console.log(`  ·    ${label}: mutation — ${scenario.mutation}`);
    results.push(
      check(`${label}: the mutation was applied`, outcome.mutated),
      check(
        `${label}: exactly one observation per host, none repeated`,
        outcome.observations.length === 2 &&
          refusedEvent !== undefined &&
          healthyEvent !== undefined,
        JSON.stringify(outcome.observations),
      ),
      check(
        `${label}: the healthy sibling host commits and its island is interactive`,
        healthyEvent?.outcome === "committed" &&
          outcome.hydratedInHealthy > 0 &&
          outcome.badgeBefore === "Units: 7" &&
          outcome.badgeAfterClick === "Units: 8",
        `${JSON.stringify(healthyEvent)} ${outcome.badgeBefore} → ${outcome.badgeAfterClick}`,
      ),
      check(
        `${label}: no reload, no build mismatch, no unhandled rejection, no page error`,
        outcome.mainFrameNavigations === 1 &&
          outcome.mismatches === 0 &&
          outcome.rejections.length === 0 &&
          outcome.pageErrors.length === 0,
        JSON.stringify({
          navigations: outcome.mainFrameNavigations,
          mismatches: outcome.mismatches,
          rejections: outcome.rejections,
          pageErrors: outcome.pageErrors,
        }),
      ),
    );

    if (scenario.expect === "committed") {
      results.push(
        check(
          `${label}: the host commits every boundary and the picker is interactive`,
          refusedEvent?.outcome === "committed" &&
            refusedEvent.committedBoundaries === refusedEvent.discoveredBoundaries &&
            outcome.errors.length === 0 &&
            outcome.consoleErrors.length === 0 &&
            outcome.pickerBefore === "Stock: 12" &&
            outcome.pickerAfterClick === "Stock: 5",
          `${JSON.stringify(refusedEvent)} ${outcome.pickerBefore} → ${outcome.pickerAfterClick} ${outcome.consoleErrors.join("|")}`,
        ),
      );
      continue;
    }

    results.push(
      check(
        `${label}: the observer reports one refusal classified as reference, zero boundaries committed`,
        refusedEvent?.outcome === "preflight-refused" &&
          refusedEvent.failureCategory === "reference" &&
          refusedEvent.committedBoundaries === 0 &&
          refusedEvent.discoveredBoundaries > 0 &&
          !refusedEvent.buildMismatch,
        JSON.stringify(refusedEvent),
      ),
      check(
        `${label}: ErrorHandler received exactly one StrataBoundaryError of category reference`,
        outcome.errors.length === 1 &&
          outcome.errors[0]?.name === "StrataBoundaryError" &&
          outcome.errors[0].category === "reference" &&
          (scenario.report ?? []).every((part) => outcome.errors[0]?.message.includes(part)),
        JSON.stringify(outcome.errors),
      ),
      check(
        `${label}: one console error only (the ErrorHandler's)`,
        outcome.consoleErrors.length === 1,
        outcome.consoleErrors.join(" | "),
      ),
      check(
        `${label}: nothing hydrated or constructed in the refused host; its picker does not respond`,
        outcome.hydratedInRefused === 0 &&
          outcome.pickerBefore === "Stock: 12" &&
          outcome.pickerAfterClick === "Stock: 12",
        `${outcome.hydratedInRefused} hydrated; picker ${outcome.pickerBefore} → ${outcome.pickerAfterClick}`,
      ),
      check(
        `${label}: the server-rendered nodes of the refused host keep identity, order and text`,
        outcome.sameNodes && outcome.sameText,
      ),
      check(`${label}: no accessor or message carries the canary`, !everyText.includes(CANARY)),
      ...(scenario.getterNeverCalled
        ? [check(`${label}: the hostile accessor was never invoked`, outcome.getterCalls === 0)]
        : []),
    );
  }

  return results.every(Boolean);
}
