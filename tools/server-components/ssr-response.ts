import { chromium } from "playwright";

import { build, check, finish, section, startProductionServer } from "./lib/harness.ts";
import type { ProductionServer } from "./lib/harness.ts";
import { printFrameworkTuple } from "./lib/security.ts";
import type { RuntimeTarget } from "./lib/security.ts";
import { resolveWrangler, startWranglerPages } from "./lib/wrangler.ts";

/**
 * `pnpm test:server-component-ssr-response`: the narrow status/recovery gate
 * for the fixture route that owns an expected repository failure. It also
 * keeps the known Angular/Analog render-error 200 behavior visible as a
 * separate control; the detailed six-category failure gate remains the
 * authority for hydration and serialization ownership.
 */

const TITLE = "Server Component SSR response and recovery";
const RECOVERY_ROUTE = "/server-component-ssr-recovery";
const privateCanary = "STRATA_RECOVERY_PRIVATE_4C8A2E71";

const stop = (): never => finish(TITLE);
const verdict: Record<string, boolean> = {};

interface CapturedResponse {
  readonly status: number;
  readonly contentType: string;
  readonly cacheControl: string | null;
  readonly body: string;
}

const request = async (url: string): Promise<CapturedResponse> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    cacheControl: response.headers.get("cache-control"),
    body: await response.text(),
  };
};

const hasHtml = (response: CapturedResponse): boolean =>
  response.contentType.includes("text/html") && response.body.length > 0;

const safeRecoveryBody = (response: CapturedResponse): boolean =>
  !response.body.includes(privateCanary) &&
  !response.body.includes("ExpectedRecoveryRepositoryFailure") &&
  !response.body.includes("Synthetic repository unavailable");

async function checkRecovery(target: RuntimeTarget): Promise<boolean> {
  section(`${target.name}: expected service recovery`);

  const healthy = await request(`${target.baseUrl}${RECOVERY_ROUTE}`);
  console.log(
    `  healthy: status ${healthy.status}, cache ${healthy.cacheControl ?? "(absent)"}, body ${JSON.stringify(healthy.body.slice(-320))}`,
  );

  const unavailable = await request(`${target.baseUrl}${RECOVERY_ROUTE}?mode=unavailable`);
  console.log(
    `  unavailable: status ${unavailable.status}, cache ${unavailable.cacheControl ?? "(absent)"}, body ${JSON.stringify(unavailable.body.slice(-320))}`,
  );

  const missing = await request(`${target.baseUrl}${RECOVERY_ROUTE}?mode=missing-context`);
  const malformed = await request(`${target.baseUrl}${RECOVERY_ROUTE}?mode=malformed-context`);
  const unrelated = await request(`${target.baseUrl}/server-component`);

  const sequential = await request(`${target.baseUrl}${RECOVERY_ROUTE}`);
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, (_, round) =>
      Promise.all([
        request(`${target.baseUrl}${RECOVERY_ROUTE}?mode=unavailable&round=${round}`),
        request(`${target.baseUrl}${RECOVERY_ROUTE}?round=${round}`),
      ]),
    ),
  );

  return [
    check(
      "healthy recovery is HTTP 200 text/html with repository-backed success content",
      healthy.status === 200 &&
        hasHtml(healthy) &&
        healthy.body.includes('data-recovery-state="success"') &&
        healthy.body.includes('data-recovery-source="repository"'),
      `${healthy.status} ${healthy.contentType}`,
    ),
    check(
      "expected repository failure is HTTP 503 text/html with a generic rendered fallback",
      unavailable.status === 503 &&
        hasHtml(unavailable) &&
        unavailable.body.includes('data-recovery-state="expected-failure"') &&
        unavailable.body.includes("Inventory temporarily unavailable") &&
        !unavailable.body.includes('data-recovery-state="success"'),
      `${unavailable.status} ${unavailable.contentType}`,
    ),
    check(
      "expected failure is marked no-store and exposes no repository error or private value",
      unavailable.cacheControl === "no-store" && safeRecoveryBody(unavailable),
      `${unavailable.cacheControl}: ${unavailable.body.slice(-500)}`,
    ),
    check(
      "missing and malformed request context are explicit HTTP 400 generic fallbacks",
      missing.status === 400 &&
        malformed.status === 400 &&
        missing.body.includes('data-recovery-state="invalid-context"') &&
        malformed.body.includes('data-recovery-state="invalid-context"') &&
        safeRecoveryBody(missing) &&
        safeRecoveryBody(malformed),
      `${missing.status}/${malformed.status}`,
    ),
    check(
      "unrelated healthy Angular route remains HTTP 200",
      unrelated.status === 200 && hasHtml(unrelated),
      `${unrelated.status} ${unrelated.contentType}`,
    ),
    check(
      "a successful request after failure remains healthy",
      sequential.status === 200 && sequential.body.includes('data-recovery-state="success"'),
      `${sequential.status}`,
    ),
    check(
      "overlapping success/failure requests stay isolated with no shared status or body",
      concurrent.every(
        ([failure, success]) =>
          failure.status === 503 &&
          failure.body.includes('data-recovery-state="expected-failure"') &&
          success.status === 200 &&
          success.body.includes('data-recovery-state="success"') &&
          safeRecoveryBody(failure) &&
          safeRecoveryBody(success),
      ),
      JSON.stringify(concurrent.map(([failure, success]) => [failure.status, success.status])),
    ),
  ].every(Boolean);
}

async function checkKnownRenderFailures(target: RuntimeTarget): Promise<boolean> {
  section(`${target.name}: unexpected render failures remain distinct controls`);

  const cases = ["constructor", "service", "template"] as const;
  const responses = await Promise.all(
    cases.map((mode) => request(`${target.baseUrl}/server-component-failure/${mode}`)),
  );

  return check(
    "constructor, injected-service and template failures remain HTTP 200 controls, not false recovery successes",
    responses.every((response, _index) => response.status === 200 && hasHtml(response)),
    JSON.stringify(responses.map(({ status, body }, index) => [cases[index], status, body.length])),
  );
}

async function checkBrowserNavigation(target: RuntimeTarget): Promise<boolean> {
  section(`${target.name}: document navigation, Back and successful re-entry`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    const origin = await page.goto(`${target.baseUrl}${RECOVERY_ROUTE}`, {
      waitUntil: "load",
      timeout: 15_000,
    });
    const originState = await page
      .locator("[data-recovery-state]")
      .getAttribute("data-recovery-state");

    const failingResponsePromise = page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        new URL(response.url()).pathname === RECOVERY_ROUTE &&
        new URL(response.url()).searchParams.get("mode") === "unavailable",
    );
    await page.locator(`a[href="${RECOVERY_ROUTE}?mode=unavailable"]`).click();
    const failing = await failingResponsePromise;
    await page.waitForLoadState("load");
    const failingState = await page
      .locator("[data-recovery-state]")
      .getAttribute("data-recovery-state");

    const back = await page.goBack({ waitUntil: "load", timeout: 15_000 });
    await page.locator('[data-recovery-state="success"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
    const backState = await page
      .locator("[data-recovery-state]")
      .getAttribute("data-recovery-state");

    const reentryResponsePromise = page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        new URL(response.url()).pathname === RECOVERY_ROUTE &&
        new URL(response.url()).searchParams.get("mode") === "unavailable",
    );
    await page.locator(`a[href="${RECOVERY_ROUTE}?mode=unavailable"]`).click();
    const reentry = await reentryResponsePromise;
    await page.waitForLoadState("load");
    const reentryState = await page
      .locator("[data-recovery-state]")
      .getAttribute("data-recovery-state");

    return [
      check(
        "healthy document loads with success content",
        origin?.status() === 200 && originState === "success",
        `${origin?.status()}/${originState}`,
      ),
      check(
        "document navigation receives HTTP 503 and renders the generic fallback",
        failing.status() === 503 && failingState === "expected-failure",
        `${failing.status()}/${failingState}`,
      ),
      check(
        "Back returns to a new healthy document",
        (back?.status() ?? 200) === 200 && backState === "success",
        `${back?.status() ?? "history-cache"}/${backState}`,
      ),
      check(
        "re-entry is another HTTP 503 document with no browser error",
        reentry.status() === 503 && reentryState === "expected-failure" && pageErrors.length === 0,
        `${reentry.status()}/${reentryState}/${pageErrors.join(" | ")}`,
      ),
    ].every(Boolean);
  } finally {
    await page.close();
    await browser.close();
  }
}

async function runTarget(target: RuntimeTarget): Promise<void> {
  verdict[`${target.name}: expected recovery`] = await checkRecovery(target);
  verdict[`${target.name}: unexpected render controls`] = await checkKnownRenderFailures(target);
  verdict[`${target.name}: browser navigation`] = await checkBrowserNavigation(target);
}

printFrameworkTuple();

section("Production build (Nitro node-server)");
build("production", {}, stop);

const nitro: ProductionServer = await startProductionServer();
try {
  await runTarget({
    name: "Nitro node-server",
    baseUrl: nitro.baseUrl,
    output: () => nitro.output(),
  });
} finally {
  await nitro.stop();
}

section("Cloudflare build: BUILD_PRESET=cloudflare-pages");
build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop);

const pages = await startWranglerPages(resolveWrangler()).catch((error: unknown) => {
  check("wrangler pages dev boots and answers", false, String(error).slice(0, 2_000));
  return stop();
});

try {
  await runTarget({
    name: "Wrangler Pages (workerd)",
    baseUrl: pages.baseUrl,
    output: () => pages.output(),
  });
} finally {
  await pages.stop();
}

section("Verdict");
for (const [name, passed] of Object.entries(verdict))
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}`);
if (!Object.values(verdict).every(Boolean)) check("every verdict line above holds", false);
stop();
