import {
  checkCommitFailure,
  checkDocumentNavigation,
  checkHealthyBaseline,
  checkPostHydrationError,
  checkPreflightIsolation,
  checkSerializationFailures,
  checkServerRenderFailures,
} from "./lib/failures.ts";
import { build, check, finish, section, startProductionServer } from "./lib/harness.ts";
import { openBrowser, printFrameworkTuple } from "./lib/security.ts";
import type { RuntimeTarget } from "./lib/security.ts";
import { resolveWrangler, startWranglerPages } from "./lib/wrangler.ts";

/**
 * `pnpm test:server-component-failures`: Server Component failure and recovery
 * (docs/research/server-component-failure-recovery.md), against the Analog
 * fixture's `/server-component-failures` and `/server-component-failure/:mode`
 * routes. Buffered SSR and document navigation only (streaming is unsupported).
 *
 *   1. resolved framework tuple
 *   2. Nitro node-server: healthy baseline, then taxonomy A–F
 *        A render, B serialization, C preflight + sibling isolation,
 *        D commit rollback, E error after hydration, F document navigation
 *   3. workerd (Wrangler Pages): baseline, A, B, C and F on the Worker runtime;
 *      D and E are browser mechanics independent of the server runtime
 *
 * Regressions (security, navigation, server-components, defer, server-only)
 * are their own gates and run next to this one in CI.
 */

const TITLE = "Server Component failure and recovery";
const stop = (): never => finish(TITLE);
const verdict: Record<string, boolean | string> = {};

printFrameworkTuple();

section("Production build (Nitro node-server)");
build("production", {}, stop);

const nitro = await startProductionServer();
const nodeTarget: RuntimeTarget = {
  name: "Nitro node-server",
  baseUrl: nitro.baseUrl,
  output: () => nitro.output(),
};
let healthyViews: number | undefined;

try {
  const browser = await openBrowser();

  try {
    const healthy = await checkHealthyBaseline(nodeTarget, browser);

    healthyViews = healthy.views;
    verdict["Node healthy baseline: SSR, nine islands, interaction, zero reports"] = healthy.ok;
    verdict["Node A server render failure"] = await checkServerRenderFailures(nodeTarget, browser);
    verdict["Node B serialization failure"] = await checkSerializationFailures(nodeTarget, browser);
    verdict["Node C preflight failure and sibling-host isolation"] = await checkPreflightIsolation(
      nodeTarget,
      browser,
    );
    verdict["Node D hydration commit failure and rollback"] = await checkCommitFailure(
      nodeTarget,
      browser,
      healthy.views,
    );
    verdict["Node E island error after successful hydration"] = await checkPostHydrationError(
      nodeTarget,
      browser,
    );
    verdict["Node F document navigation, Back and re-entry"] = await checkDocumentNavigation(
      nodeTarget,
      browser,
    );
  } finally {
    await browser.close();
  }
} finally {
  await nitro.stop();
}

section("Cloudflare build: BUILD_PRESET=cloudflare-pages");
build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop);

{
  const pages = await startWranglerPages(resolveWrangler()).catch((error: unknown) => {
    check("wrangler pages dev boots and answers", false, String(error).slice(0, 2_000));

    return stop();
  });
  const workerTarget: RuntimeTarget = {
    name: "Wrangler Pages (workerd)",
    baseUrl: pages.baseUrl,
    output: () => pages.output(),
  };

  try {
    const browser = await openBrowser();

    try {
      const healthy = await checkHealthyBaseline(workerTarget, browser);

      verdict["workerd healthy baseline: SSR, nine islands, interaction, zero reports"] =
        healthy.ok &&
        check(
          "the nine-island view count is the same on both runtimes",
          healthy.views === healthyViews,
          `${healthy.views} vs ${healthyViews}`,
        );
      verdict["workerd A server render failure"] = await checkServerRenderFailures(
        workerTarget,
        browser,
      );
      verdict["workerd B serialization failure"] = await checkSerializationFailures(
        workerTarget,
        browser,
      );
      verdict["workerd C preflight failure and sibling-host isolation"] =
        await checkPreflightIsolation(workerTarget, browser);
      verdict["workerd F document navigation, Back and re-entry"] = await checkDocumentNavigation(
        workerTarget,
        browser,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await pages.stop();
  }
}

section("Verdict");

for (const [name, passed] of Object.entries(verdict)) {
  console.log(`${passed === true ? "  ok  " : " FAIL "} ${name}`);
}

if (!Object.values(verdict).every((passed) => passed === true)) {
  check("every verdict line above holds", false);
}

stop();
