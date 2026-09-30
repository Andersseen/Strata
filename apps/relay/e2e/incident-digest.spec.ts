import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { collectAngularErrors } from "./angular-errors";

async function createIncident(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/ops/incidents", {
    data: {
      title,
      serviceId: "checkout",
      environment: "production",
      severity: "critical",
      summary: "Created by the incident digest end-to-end test.",
    },
  });

  expect(response.ok()).toBe(true);

  return ((await response.json()) as { incident: { id: string } }).incident.id;
}

test("the server render reads what a controller just wrote", async ({ request }) => {
  const title = `SSR shared state ${Date.now()}`;
  const id = await createIncident(request, title);

  // Raw HTML, before any browser JavaScript: the Server Component rendered it.
  const html = await (await request.get("/incidents")).text();

  expect(html).toContain(title);
  expect(html).toMatch(
    new RegExp(
      `<relay-incident-triage data-strata-client="relay-incident-triage" data-strata-props="[^"]*${id}[^"]*" ngh="\\d+">`,
    ),
  );
  expect(html).not.toContain("RELAY_INCIDENT_DIGEST_SERVER_SOURCE_3E77");
  expect(html).not.toContain("RELAY_INCIDENT_DIGEST_SERVER_IMPLEMENTATION_5B02");
});

test("hydrates one triage island per incident and resolves through the controller", async ({
  page,
  request,
}) => {
  const errors = collectAngularErrors(page);
  const title = `Triage island ${Date.now()}`;
  const id = await createIncident(request, title);

  await page.goto("/");
  await page.locator('a[href="/incidents"]').click();
  await expect(page).toHaveURL(/\/incidents$/);

  const digest = page.locator("relay-incident-digest");
  const items = digest.locator(".digest-item");
  const item = digest.locator(`[data-incident="${id}"]`);

  await expect(item.getByRole("heading", { name: title })).toBeVisible();
  // Every active incident's island hydrated as its own root, and nothing else did.
  await expect(digest.locator("[data-strata-hydrated]")).toHaveCount(await items.count());
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(await items.count());
  await expect(item.locator("relay-incident-triage")).toHaveAttribute("data-strata-hydrated", "");

  const triage = item.getByRole("group", { name: `Triage ${id}` });
  await expect(triage.locator("output")).toHaveText("Status: open");

  await triage.getByRole("button", { name: "Start monitoring" }).click();
  await expect(triage.locator("output")).toHaveText("Status: monitoring");
  await expect(triage.getByRole("button", { name: "Start monitoring" })).toHaveCount(0);

  const patch = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/ops/incidents/${id}`) &&
      response.request().method() === "PATCH",
  );
  await triage.getByRole("button", { name: `Resolve ${id}` }).click();
  expect((await patch).status()).toBe(200);
  await expect(triage.locator("output")).toHaveText("Status: resolved");

  // A new document request: the server renders from the updated store.
  await page.reload();
  await expect(page.locator(`[data-incident="${id}"]`)).toHaveCount(0);
  await expect(page.locator("relay-incident-digest [data-strata-hydrated]")).toHaveCount(
    await page.locator("relay-incident-digest .digest-item").count(),
  );

  expect(errors).toEqual([]);
});
