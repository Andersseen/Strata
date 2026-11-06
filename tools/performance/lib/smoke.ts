import type { Page } from "playwright";

import { evaluate, openTracked } from "../../server-components/lib/package-consumer.ts";
import type { Tracked } from "../../server-components/lib/package-consumer.ts";

import type { IslandCount } from "./arms.ts";
import {
  canariesIn,
  islandInteractionProblems,
  islandReplayProblems,
  islandsFor,
} from "./contract.ts";
import type { IslandObservation, IslandReplayObservation, IslandSpec } from "./contract.ts";

/**
 * The hydration and interaction smoke, identical for all four arms. It asserts correctness only; it
 * is not a browser performance measurement. Each page load proves one thing:
 *
 *   hydrated  Wait for hydration WITHOUT touching the page, then click each island exactly once: one
 *             API request, only that island changes, the SSR nodes are the hydrated nodes.
 *   replay    Click while the scripts are held, before any handler exists. Nothing may happen yet;
 *             after hydration Angular's event replay must run each click exactly once.
 *
 * Neither phase clicks "until something happens", because a click before hydration is not lost: the
 * early event contract queues it, and each queued click later becomes a request of its own. A loop
 * that retries while the page looks idle therefore manufactures the duplicate it is meant to detect
 * (Extended 42207479355, reproduced in arm A, which has no Strata code).
 */

/** After the last expected effect: how long a duplicate has to show itself. */
const QUIET_MS = 300;
const POLL_MS = 25;

/**
 * Calls of `fetch` as the page made them. Playwright's `request` event is delivered later, so it can
 * only ever undercount at the moment of a check; the two are compared once the page is quiet.
 */
const FETCH_PROBE = `(() => {
  window.__strataFetches = [];
  const original = window.fetch;
  window.fetch = function (input) {
    window.__strataFetches.push(String((input && input.url) || input));
    return original.apply(this, arguments);
  };
})()`;

/** A deliberate fault for the negative controls; never set by the benchmark itself. */
export interface IslandFault {
  readonly island: "availability" | "stock" | "delivery";
  /**
   * `swallow-click`: the button's handler never runs. `block-api`: the API request is aborted.
   * `duplicate-request`: each click also issues a second request. `lose-replay`: the queued early
   * events are dropped before Angular can replay them.
   */
  readonly kind: "swallow-click" | "block-api" | "duplicate-request" | "lose-replay";
}

export interface SmokeOptions {
  readonly base: string;
  /** Milliseconds allowed for hydration, and again for each effect. */
  readonly timeoutMs?: number;
}

export interface IslandsSmokeOptions extends SmokeOptions {
  readonly islands: IslandCount;
  readonly fault?: IslandFault;
}

const q = (selector: string, part: "button" | "output"): string => `${selector} ${part}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

interface GatedPage {
  readonly tracked: Tracked;
  readonly page: Page;
  readonly release: () => void;
  readonly statuses: () => Promise<Record<string, string>>;
  readonly fetchesOf: (spec: IslandSpec) => Promise<number>;
  readonly hydrated: (spec: IslandSpec) => Promise<boolean>;
  readonly shape: (spec: IslandSpec) => Promise<{ count: number; reused: boolean }>;
  readonly before: Record<string, string>;
}

/** The SSR document with every application script held and every island's SSR nodes tagged. */
async function openGated(
  specs: readonly IslandSpec[],
  { base, timeoutMs, fault }: Required<SmokeOptions> & Pick<IslandsSmokeOptions, "fault">,
  problems: string[],
): Promise<GatedPage> {
  const tracked = await openTracked();
  const { page } = tracked;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const target = specs.find((spec) => spec.id === fault?.island);

  await page.addInitScript(FETCH_PROBE);
  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  if (fault?.kind === "block-api") {
    await page.route(`**${target!.apiPath}`, (route) => route.abort());
  }

  await page.goto(`${base}/products/42`, { waitUntil: "commit" });
  for (const spec of specs)
    await page.waitForSelector(q(spec.selector, "button"), {
      state: "attached",
      timeout: timeoutMs,
    });

  if (fault?.kind === "swallow-click") {
    await evaluate(
      page,
      `document.querySelector('${q(target!.selector, "button")}').addEventListener('click', (e) => e.stopImmediatePropagation(), true)`,
    );
  }
  if (fault?.kind === "duplicate-request") {
    await evaluate(
      page,
      `document.querySelector('${q(target!.selector, "button")}').addEventListener('click', () => void fetch('${target!.apiPath}'))`,
    );
  }

  const pairs = JSON.stringify(specs.map((spec) => [spec.id, spec.selector]));
  const statuses = (): Promise<Record<string, string>> =>
    evaluate<Record<string, string>>(
      page,
      `Object.fromEntries(${pairs}.map(([id, selector]) => [id, document.querySelector(selector + ' output')?.textContent ?? '']))`,
    );

  const title = await evaluate<string | null>(
    page,
    `(() => {
      window.__ssr = { heading: document.querySelector('h1') };
      for (const [id, selector] of ${pairs}) {
        const output = document.querySelector(selector + ' output');
        window.__ssr[id] = {
          button: document.querySelector(selector + ' button'),
          output,
          text: output && output.firstChild,
        };
      }
      return document.querySelector('h1')?.textContent ?? null;
    })()`,
  );

  if (title !== "Product 42") problems.push(`SSR DOM before any script: title "${title}"`);

  return {
    tracked,
    page,
    release,
    statuses,
    before: await statuses(),
    fetchesOf: (spec) =>
      evaluate<number>(
        page,
        `window.__strataFetches.filter((url) => url.endsWith('${spec.apiPath}')).length`,
      ),
    // Angular's own back-reference from a node to its view, written when the node is hydrated; the
    // listeners are attached in the same creation pass. It is private, so a rename fails every
    // smoke with "did not hydrate" rather than passing one.
    hydrated: (spec) =>
      evaluate<boolean>(
        page,
        `!!document.querySelector('${q(spec.selector, "button")}')?.__ngContext__`,
      ),
    shape: (spec) =>
      evaluate<{ count: number; reused: boolean }>(
        page,
        `(() => {
          const tagged = window.__ssr['${spec.id}'];
          const output = document.querySelector('${q(spec.selector, "output")}');
          return {
            count: document.querySelectorAll('${spec.selector}').length,
            reused:
              tagged.button === document.querySelector('${q(spec.selector, "button")}') &&
              tagged.output === output &&
              tagged.text === (output && output.firstChild) &&
              window.__ssr.heading === document.querySelector('h1'),
          };
        })()`,
      ),
  };
}

/** Requests as the page issued them, and the same count as the browser's network layer saw it. */
async function requestsOf(gated: GatedPage, spec: IslandSpec, problems: string[]): Promise<number> {
  const fetches = await gated.fetchesOf(spec);
  const seen = gated.tracked.requests.filter((request) => request.url.endsWith(spec.apiPath));

  if (seen.length !== fetches)
    problems.push(
      `${spec.id}: the page issued ${fetches} request(s), the network saw ${seen.length}`,
    );

  return fetches;
}

async function finalProblems({ page, tracked }: GatedPage): Promise<string[]> {
  const html = await evaluate<string>(page, "document.documentElement.outerHTML");

  return [
    ...canariesIn(html).map((canary) => `hydrated DOM exposes ${canary}`),
    ...(tracked.errors.length > 0 ? [`browser errors: ${tracked.errors.join(" | ")}`] : []),
    ...(tracked.failedRequests.length > 0
      ? [`failed requests: ${tracked.failedRequests.join(" | ")}`]
      : []),
  ];
}

async function waitForHydration(
  gated: GatedPage,
  specs: readonly IslandSpec[],
  timeoutMs: number,
  problems: string[],
): Promise<readonly IslandSpec[]> {
  const ready: IslandSpec[] = [];

  for (const spec of specs) {
    if (await until(() => gated.hydrated(spec), timeoutMs)) ready.push(spec);
    else problems.push(`${spec.id}: did not hydrate within ${timeoutMs} ms`);
  }

  return ready;
}

async function hydratedInteraction(
  specs: readonly IslandSpec[],
  options: Required<SmokeOptions> & Pick<IslandsSmokeOptions, "fault">,
): Promise<string[]> {
  const problems: string[] = [];
  const gated = await openGated(specs, options, problems);

  try {
    gated.release();

    const ready = await waitForHydration(gated, specs, options.timeoutMs, problems);
    const observations: IslandObservation[] = [];

    for (const spec of ready) {
      await gated.page.click(q(spec.selector, "button"), { timeout: options.timeoutMs });
      await until(async () => {
        const status = (await gated.statuses())[spec.id];

        return status !== spec.initial && status !== "";
      }, options.timeoutMs);
      await sleep(QUIET_MS);

      observations.push({
        id: spec.id,
        ...(await gated.shape(spec)),
        before: gated.before[spec.id] ?? "",
        statusesAfterClick: await gated.statuses(),
        requests: await requestsOf(gated, spec, problems),
      });
    }

    problems.push(...islandInteractionProblems(specs, observations));
    problems.push(...(await finalProblems(gated)));
  } finally {
    gated.release();
    await gated.tracked.close();
  }

  return problems;
}

/** The first island gets two early clicks: replay must run one effect per click, not one per island. */
const earlyClicks = (index: number): number => (index === 0 ? 2 : 1);

async function replayInteraction(
  specs: readonly IslandSpec[],
  options: Required<SmokeOptions> & Pick<IslandsSmokeOptions, "fault">,
): Promise<string[]> {
  const problems: string[] = [];
  const gated = await openGated(specs, options, problems);

  try {
    for (const [index, spec] of specs.entries()) {
      for (let click = 0; click < earlyClicks(index); click++) {
        await gated.page.click(q(spec.selector, "button"), {
          force: true,
          timeout: options.timeoutMs,
        });
      }
    }

    const early = await Promise.all(specs.map((spec) => gated.fetchesOf(spec)));

    if (options.fault?.kind === "lose-replay") {
      await evaluate(
        gated.page,
        "Object.values(window._ejsas ?? {}).forEach((contract) => { contract.q.length = 0; })",
      );
    }

    gated.release();
    await waitForHydration(gated, specs, options.timeoutMs, problems);

    // Settled when every queued click has run. A lost click runs into the timeout, a duplicate into
    // the quiet period; both then fail the exact count below.
    await until(async () => {
      const counts = await Promise.all(specs.map((spec) => gated.fetchesOf(spec)));
      const current = await gated.statuses();

      return specs.every(
        (spec, index) => counts[index]! >= earlyClicks(index) && current[spec.id] !== spec.initial,
      );
    }, options.timeoutMs);
    await sleep(QUIET_MS);

    const final = await gated.statuses();
    const observations: IslandReplayObservation[] = [];

    for (const [index, spec] of specs.entries()) {
      observations.push({
        id: spec.id,
        ...(await gated.shape(spec)),
        clicks: earlyClicks(index),
        requestsBeforeHydration: early[index]!,
        requests: await requestsOf(gated, spec, problems),
        status: final[spec.id] ?? "",
      });
    }

    problems.push(...islandReplayProblems(specs, observations).map((p) => `replay: ${p}`));
    problems.push(...(await finalProblems(gated)));
  } finally {
    gated.release();
    await gated.tracked.close();
  }

  return problems;
}

export async function islandsSmoke({
  base,
  islands,
  timeoutMs = 20_000,
  fault,
}: IslandsSmokeOptions): Promise<string[]> {
  const specs = islandsFor(islands);
  const options = { base, timeoutMs, fault };
  const guarded = (phase: typeof hydratedInteraction): Promise<string[]> =>
    phase(specs, options).catch((error: unknown) => [
      `browser smoke threw: ${error instanceof Error ? error.message : String(error)}`,
    ]);

  return [...(await guarded(hydratedInteraction)), ...(await guarded(replayInteraction))];
}

/** The one-island profile: the same two proofs on the PR #86 baseline. */
export const browserSmoke = (options: SmokeOptions): Promise<string[]> =>
  islandsSmoke({ ...options, islands: 1 });
