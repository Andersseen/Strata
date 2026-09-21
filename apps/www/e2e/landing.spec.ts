import { expect, test } from "@playwright/test";

test("renders the SSR landing and supports its essential interactions", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /give your server structure/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /native to the nitro seam/i })).toBeVisible();

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const controllerPanel = page.locator("strata-code-panel").first();
  await controllerPanel.getByRole("button", { name: "Copy" }).click();
  await expect(controllerPanel.getByRole("button", { name: "Copied" })).toBeVisible();
});
