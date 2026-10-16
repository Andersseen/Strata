import { evaluate, openTracked } from "../../server-components/lib/package-consumer.ts";

import type { IslandCount } from "./arms.ts";
import { canariesIn, islandInteractionProblems, islandsFor } from "./contract.ts";
import type { IslandObservation } from "./contract.ts";

/**
 * One hydration/interaction smoke per arm and runtime, identical for all four arms: the
 * SSR DOM is visible before any script runs, the island's nodes are REUSED by hydration,
 * and a click performs the public API request and renders its result. It asserts
 * correctness only; it is not a browser performance measurement.
 */

const BUTTON = "product-availability button";
const OUTPUT = "product-availability output";

export interface SmokeOptions {
  readonly base: string;
  /** Milliseconds allowed for hydration plus the click to take effect. */
  readonly timeoutMs?: number;
}

export async function browserSmoke({ base, timeoutMs = 20_000 }: SmokeOptions): Promise<string[]> {
  const problems: string[] = [];
  const tracked = await openTracked();
  const { page } = tracked;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Hold the application scripts so the SSR DOM can be tagged before hydration.
  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });

  try {
    await page.goto(`${base}/products/42`, { waitUntil: "commit" });
    await page.waitForSelector(BUTTON, { state: "attached", timeout: timeoutMs });

    const before = await evaluate<{ title: string | null; status: string | null }>(
      page,
      `(() => {
        const output = document.querySelector('${OUTPUT}');
        window.__ssr = {
          button: document.querySelector('${BUTTON}'),
          output,
          text: output && output.firstChild,
          heading: document.querySelector('h1'),
        };
        return { title: document.querySelector('h1')?.textContent ?? null, status: output?.textContent ?? null };
      })()`,
    );

    if (before.title !== "Product 42" || before.status !== "Availability: not checked")
      problems.push(`SSR DOM before any script: ${JSON.stringify(before)}`);

    release();

    // The click handler only exists once the island is hydrated: click until it answers.
    const deadline = Date.now() + timeoutMs;
    let status = "";

    while (Date.now() < deadline) {
      await page.click(BUTTON);
      await new Promise((resolve) => setTimeout(resolve, 150));
      status =
        (await evaluate<string>(page, `document.querySelector('${OUTPUT}')?.textContent ?? ''`)) ??
        "";
      if (status !== "Availability: not checked" && status !== "") break;
    }

    if (status !== "Availability: available")
      problems.push(`the click did not render the API result (status "${status}")`);

    const same = await evaluate<Record<string, boolean>>(
      page,
      `(() => ({
        button: window.__ssr.button === document.querySelector('${BUTTON}'),
        output: window.__ssr.output === document.querySelector('${OUTPUT}'),
        text: window.__ssr.text === document.querySelector('${OUTPUT}').firstChild,
        heading: window.__ssr.heading === document.querySelector('h1'),
      }))()`,
    );

    if (!Object.values(same).every(Boolean))
      problems.push(`hydration did not reuse the SSR nodes: ${JSON.stringify(same)}`);

    const api = tracked.requests.filter((request) => request.url.endsWith("/api/products/42"));

    if (api.length === 0) problems.push("no /api/products/42 request was made");
    if (tracked.errors.length > 0) problems.push(`browser errors: ${tracked.errors.join(" | ")}`);
  } catch (error) {
    problems.push(`browser smoke threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    release();
    await tracked.close();
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Several independent islands

/** A deliberate fault for the negative controls; never set by the benchmark itself. */
export interface IslandFault {
  readonly island: "availability" | "stock" | "delivery";
  /** `swallow-click`: the button's handler never runs. `block-api`: the API request is aborted. */
  readonly kind: "swallow-click" | "block-api";
}

export interface IslandsSmokeOptions {
  readonly base: string;
  readonly islands: IslandCount;
  readonly timeoutMs?: number;
  readonly fault?: IslandFault;
}

const q = (selector: string, part: "button" | "output"): string => `${selector} ${part}`;

/**
 * The multi-island counterpart of `browserSmoke`, driven by the same rules: tag every island's
 * SSR nodes before any script runs, release the scripts, then click each island ONCE (after its
 * own hydration, which is the first click that has any effect) and require that exactly that
 * island changed, with exactly one API request, and that no hydration warning, console error,
 * duplicate island or failed request occurred.
 */
export async function islandsSmoke({
  base,
  islands,
  timeoutMs = 20_000,
  fault,
}: IslandsSmokeOptions): Promise<string[]> {
  const specs = islandsFor(islands);
  const problems: string[] = [];
  const tracked = await openTracked();
  const { page } = tracked;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });

  if (fault?.kind === "block-api") {
    const target = specs.find((spec) => spec.id === fault.island)!;

    await page.route(`**${target.apiPath}`, (route) => route.abort());
  }

  try {
    await page.goto(`${base}/products/42`, { waitUntil: "commit" });
    for (const spec of specs)
      await page.waitForSelector(q(spec.selector, "button"), {
        state: "attached",
        timeout: timeoutMs,
      });

    if (fault?.kind === "swallow-click") {
      const target = specs.find((spec) => spec.id === fault.island)!;

      await evaluate(
        page,
        `document.querySelector('${q(target.selector, "button")}').addEventListener('click', (e) => e.stopImmediatePropagation(), true)`,
      );
    }

    // Tag the original SSR nodes of every island before any application script runs.
    await evaluate(
      page,
      `(() => {
        window.__ssr = {};
        for (const [id, selector] of ${JSON.stringify(specs.map((s) => [s.id, s.selector]))}) {
          const output = document.querySelector(selector + ' output');
          window.__ssr[id] = {
            button: document.querySelector(selector + ' button'),
            output,
            text: output && output.firstChild,
          };
        }
      })()`,
    );

    const statusesOf = (): Promise<Record<string, string>> =>
      evaluate<Record<string, string>>(
        page,
        `(() => Object.fromEntries(${JSON.stringify(specs.map((s) => [s.id, s.selector]))}.map(([id, selector]) => [id, document.querySelector(selector + ' output')?.textContent ?? ''])))()`,
      );
    const before = await statusesOf();

    release();

    const observations: IslandObservation[] = [];

    for (const spec of specs) {
      const clickable = q(spec.selector, "button");
      const deadline = Date.now() + timeoutMs;
      let settled: Record<string, string> = await statusesOf();

      // The handler exists only once THIS island is hydrated: click until it answers.
      while (Date.now() < deadline) {
        await page.click(clickable, { force: true, timeout: 2_000 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        settled = await statusesOf();
        if (settled[spec.id] !== spec.initial && settled[spec.id] !== "") break;
      }

      const shape = await evaluate<{ count: number; reused: boolean }>(
        page,
        `(() => {
          const tagged = window.__ssr['${spec.id}'];
          const output = document.querySelector('${q(spec.selector, "output")}');
          return {
            count: document.querySelectorAll('${spec.selector}').length,
            reused:
              tagged.button === document.querySelector('${clickable}') &&
              tagged.output === output &&
              tagged.text === (output && output.firstChild),
          };
        })()`,
      );

      observations.push({
        id: spec.id,
        count: shape.count,
        reused: shape.reused,
        before: before[spec.id] ?? "",
        statusesAfterClick: settled,
        requests: tracked.requests.filter((request) => request.url.endsWith(spec.apiPath)).length,
      });
    }

    problems.push(...islandInteractionProblems(specs, observations));

    // The final DOM must be free of private values and must not contain a duplicated island.
    const html = await evaluate<string>(page, "document.documentElement.outerHTML");

    problems.push(...canariesIn(html).map((canary) => `hydrated DOM exposes ${canary}`));
    if (tracked.errors.length > 0) problems.push(`browser errors: ${tracked.errors.join(" | ")}`);
    if (tracked.failedRequests.length > 0)
      problems.push(`failed requests: ${tracked.failedRequests.join(" | ")}`);
  } catch (error) {
    problems.push(`browser smoke threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    release();
    await tracked.close();
  }

  return problems;
}
