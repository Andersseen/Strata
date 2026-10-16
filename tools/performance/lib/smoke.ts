import { evaluate, openTracked } from "../../server-components/lib/package-consumer.ts";

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
