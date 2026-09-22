import { expect, test } from "@playwright/test";

test("renders the SSR landing and supports its essential interactions", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page.locator("#app-preload")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("heading", { name: /give your server structure/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /native to the nitro seam/i })).toBeVisible();
  await expect(page.locator("volt-card.feature-card").first()).toHaveCSS(
    "background-color",
    "rgb(17, 21, 29)",
  );
  await expect(page.locator("volt-tabs-list")).toHaveCSS("background-color", "rgb(23, 28, 38)");

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const controllerPanel = page.locator("strata-code-panel").first();
  await controllerPanel.getByRole("button", { name: "Copy" }).click();
  await expect(controllerPanel.getByRole("button", { name: "Copied" })).toBeVisible();
});
