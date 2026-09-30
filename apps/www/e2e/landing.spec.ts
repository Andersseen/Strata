import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Angular's own runtime errors (hydration mismatches, NG0xxx codes, duplicate
// component or selector collisions). Unrelated console noise is not a failure.
const ANGULAR_ERROR = /hydrat|NG0\d{3}|duplicate|selector|multiple components match/i;

function collectAngularErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (
      (message.type() === "error" || message.type() === "warning") &&
      ANGULAR_ERROR.test(message.text())
    ) {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  return errors;
}

test("renders the SSR landing and supports its essential interactions", async ({ page }) => {
  const errors = collectAngularErrors(page);

  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page.locator("#app-preload")).toHaveAttribute("aria-hidden", "true");
  await expect(
    page.getByRole("heading", { name: /the server layer angular was missing/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /controllers for the http side/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /native to the nitro seam/i })).toBeVisible();
  await expect(page.locator("volt-card.feature-card").first()).toHaveCSS(
    "background-color",
    "rgb(17, 21, 29)",
  );
  await expect(page.locator("volt-tabs-list").first()).toHaveCSS(
    "background-color",
    "rgb(23, 28, 38)",
  );

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const codePanel = page.locator("strata-code-panel").first();
  await codePanel.getByRole("button", { name: "Copy" }).click();
  await expect(codePanel.getByRole("button", { name: "Copied" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("hydrates the Server Component's client island and nothing else", async ({ page }) => {
  const errors = collectAngularErrors(page);

  await page.goto("/");

  const section = page.locator("#server-components");
  const island = section.locator("strata-server-demo");
  const output = island.locator("output");
  const button = island.getByRole("button", { name: "Run interaction" });

  await expect(
    section.getByRole("heading", { name: /angular components that stay on the server/i }),
  ).toBeVisible();
  await expect(section.getByText("Experimental", { exact: true })).toBeVisible();
  await expect(section.getByText(/not supported yet/i)).toBeVisible();

  // The island hydrated from the server-serialized props, as its own root.
  await expect(island).toHaveAttribute("data-strata-hydrated", "");
  await expect(page.locator("[data-strata-hydrated]")).toHaveCount(1);
  await expect(island).toContainText("ServerComponentsShowcase");
  await expect(island).toContainText("3 server-only modules");
  await expect(output).toHaveText("Interactions: 0");

  await button.click();
  await expect(output).toHaveText("Interactions: 1");

  await button.focus();
  await page.keyboard.press("Enter");
  await expect(output).toHaveText("Interactions: 2");

  expect(errors).toEqual([]);
});
