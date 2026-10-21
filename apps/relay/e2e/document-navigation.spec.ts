import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { collectAngularErrors } from "./angular-errors";

declare global {
  interface Window {
    __RELAY_REALM__?: string;
  }
}

/** Records real document requests (the browser's navigation requests). */
function documentRequests(page: Page): string[] {
  const urls: string[] = [];

  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      const url = new URL(request.url());

      urls.push(`${url.pathname}${url.search}`);
    }
  });

  return urls;
}

const inSameRealm = (page: Page) => page.evaluate(() => window.__RELAY_REALM__ === "origin");

test("document links and programmatic navigation reach the server, preserve query and fragment, and hydrate once", async ({
  page,
}) => {
  const errors = collectAngularErrors(page);
  const documents = documentRequests(page);

  // 1. The overview, loaded directly.
  await page.goto("/");
  await page.evaluate(() => {
    window.__RELAY_REALM__ = "origin";
  });
  expect(await inSameRealm(page)).toBe(true);

  // 2. StrataDocumentLink renders a native, server-rendered anchor.
  const release = page.locator('a[href="/release"]');
  await expect(release).toHaveCount(1);
  await release.click();
  await expect(page).toHaveURL(/\/release$/);
  expect(await inSameRealm(page)).toBe(false);
  expect(documents).toContain("/release");

  const gate = page.locator("relay-release-gate");
  await expect(gate.locator("[data-strata-hydrated]")).toHaveCount(1);
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(2);
  await gate.getByLabel("Canary allocation").fill("25");
  await gate.getByRole("button", { name: "Simulate rollout" }).click();
  await expect(gate.getByRole("button", { name: "Canary simulated" })).toBeVisible();

  // 3. Programmatic navigation to another server-owned route: query + fragment.
  await page.evaluate(() => {
    window.__RELAY_REALM__ = "release";
  });
  await page.getByRole("button", { name: "Open incident digest" }).click();
  await expect(page).toHaveURL(/\/incidents\?from=release#incident-digest-title$/);
  expect(await page.evaluate(() => window.__RELAY_REALM__)).toBeUndefined();
  expect(documents).toContain("/incidents?from=release");

  const digest = page.locator("relay-incident-digest");
  const items = digest.locator(".digest-item");
  const count = await items.count();

  expect(count).toBeGreaterThan(0);
  await expect(digest.locator("[data-strata-hydrated]")).toHaveCount(count);
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(count);

  // 4. Back: a server-rendered release gate again, its island fresh and hydrated once.
  await page.goBack({ waitUntil: "load" });
  await expect(page).toHaveURL(/\/release$/);
  await expect(page.locator("relay-release-gate [data-strata-hydrated]")).toHaveCount(1);
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(2);

  // 5. The back link is a document link too; Back and Forward re-request the documents.
  await page.getByRole("link", { name: "← Back to operations" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("relay-operations-briefing [data-strata-hydrated]")).toHaveCount(2);
  await page.goBack({ waitUntil: "load" });
  await expect(page).toHaveURL(/\/release$/);
  await expect(page.locator("relay-release-gate [data-strata-hydrated]")).toHaveCount(1);
  await page.goForward({ waitUntil: "load" });
  await expect(page).toHaveURL(/\/$/);

  expect(errors).toEqual([]);
});
