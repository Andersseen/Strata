import { expect, test } from "@playwright/test";

test("hydrates multiple islands inside the operations briefing", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/");

  const briefing = page.locator("relay-operations-briefing");
  await expect(briefing.locator("[data-server-evidence]")).toHaveAttribute(
    "data-server-evidence",
    /SERVER_IMPLEMENTATION/,
  );
  await expect(briefing.locator("[data-strata-hydrated]")).toHaveCount(2);

  await briefing.getByRole("button", { name: "Acknowledge briefing" }).click();
  await expect(briefing.getByText("Client island handled the interaction.")).toBeVisible();

  await briefing.getByRole("button", { name: "60m" }).click();
  await expect(briefing.getByText("Client window: 60 minutes")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("uses document navigation for the release gate and hydrates its rollout island", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('a[href="/release"]').click();

  await expect(page).toHaveURL(/\/release$/);
  const releaseGate = page.locator("relay-release-gate");
  await expect(releaseGate.locator("[data-server-evidence]")).toHaveAttribute(
    "data-server-evidence",
    /SERVER_IMPLEMENTATION/,
  );
  await expect(releaseGate.locator("[data-strata-hydrated]")).toHaveCount(1);

  await releaseGate.getByLabel("Canary allocation").fill("25");
  await expect(releaseGate.getByText("25% · 1200 req/min projected")).toBeVisible();
  await releaseGate.getByRole("button", { name: "Simulate rollout" }).click();
  await expect(releaseGate.getByRole("button", { name: "Canary simulated" })).toBeVisible();
});
