import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { collectAngularErrors } from "./angular-errors";

/** The deferred wave plan's marker: only its lazy chunk contains it. */
const WAVE_PLAN_MARKER = "RELAY_ROLLOUT_WAVE_PLAN_DEFERRED_5C3A";

/** Paths of the scripts the page loaded whose body contains a marker. */
function collectScripts(page: Page): (marker: string) => Promise<string[]> {
  const scripts: Promise<{ path: string; body: string }>[] = [];

  page.on("response", (response) => {
    if (response.request().resourceType() === "script") {
      scripts.push(
        response
          .text()
          .catch(() => "")
          .then((body) => ({ path: new URL(response.url()).pathname, body })),
      );
    }
  });

  return async (marker) =>
    (await Promise.all(scripts)).filter((s) => s.body.includes(marker)).map((s) => s.path);
}

test("hydrates multiple islands inside the operations briefing", async ({ page }) => {
  const consoleErrors = collectAngularErrors(page);

  await page.goto("/");

  const briefing = page.locator("relay-operations-briefing");
  await expect(briefing.locator("[data-server-evidence]")).toHaveAttribute(
    "data-server-evidence",
    /^[0-9a-f]+\.[0-9a-f]+$/,
  );
  await expect(briefing.locator("[data-strata-hydrated]")).toHaveCount(2);
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(2);

  // The acknowledgement island is marked inside a nested Server Component: the
  // nested host is inert server HTML, its island hydrated by the outer surrogate.
  const nested = briefing.locator("relay-briefing-metadata");
  await expect(nested).not.toHaveAttribute("data-strata-hydrated");
  await expect(nested.locator("[data-nested-server-evidence]")).toHaveAttribute(
    "data-nested-server-evidence",
    /^[0-9a-f]+$/,
  );
  await expect(nested.locator("relay-briefing-acknowledgement")).toHaveAttribute(
    "data-strata-hydrated",
    "",
  );

  await briefing.getByRole("button", { name: "Acknowledge briefing" }).click();
  await expect(briefing.getByText("Client island handled the interaction.")).toBeVisible();

  await briefing.getByRole("button", { name: "60m" }).click();
  await expect(briefing.getByText("Client window: 60 minutes")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("uses document navigation for the release gate and hydrates its rollout island", async ({
  page,
}) => {
  const errors = collectAngularErrors(page);
  const scriptsWith = collectScripts(page);

  await page.goto("/");
  await page.locator('a[href="/release"]').click();

  await expect(page).toHaveURL(/\/release$/);
  const releaseGate = page.locator("relay-release-gate");
  await expect(releaseGate.locator("[data-server-evidence]")).toHaveAttribute(
    "data-server-evidence",
    /^[0-9a-f]+\.[0-9a-f]+$/,
  );
  await expect(releaseGate.locator("[data-strata-hydrated]")).toHaveCount(1);

  await releaseGate.getByLabel("Canary allocation").fill("25");
  await expect(releaseGate.getByText("25% · 1200 req/min projected")).toBeVisible();
  await releaseGate.getByRole("button", { name: "Simulate rollout" }).click();
  await expect(releaseGate.getByRole("button", { name: "Canary simulated" })).toBeVisible();

  // Angular's own @defer (hydrate on interaction) inside the island: the wave
  // plan is server-rendered, its code is fetched only when it is first used,
  // and that one click is replayed onto the hydrated component.
  const wavePlan = releaseGate.locator("relay-rollout-wave-plan");
  await expect(wavePlan.getByText("25% · 1200 req/min")).toBeVisible();
  expect(await scriptsWith(WAVE_PLAN_MARKER)).toEqual([]);
  await wavePlan.getByRole("button", { name: "Pin wave plan" }).click();
  await expect(wavePlan.getByRole("button", { name: "Wave plan pinned" })).toBeVisible();
  expect(await scriptsWith(WAVE_PLAN_MARKER)).toHaveLength(1);

  // The nested briefing Server Component, imported directly by this page:
  // its own surrogate hydrates its island.
  const metadata = page.locator("relay-briefing-metadata");
  await expect(metadata.locator("[data-strata-hydrated]")).toHaveCount(1);
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(2);
  await metadata.getByRole("button", { name: "Acknowledge briefing" }).click();
  await expect(metadata.getByText("Client island handled the interaction.")).toBeVisible();
  expect(errors).toEqual([]);
});
