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

test("offers a mobile menu, a copyable install command and the quick start", async ({ page }) => {
  const errors = collectAngularErrors(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");

  await page.getByRole("button", { name: "Copy install command" }).click();
  await expect(page.getByRole("button", { name: "Install command copied" })).toBeVisible();

  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.getByRole("dialog");
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "Quick start" }).click();
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("heading", { name: /from install to first island in two files/i }),
  ).toBeInViewport();

  expect(errors).toEqual([]);
});

test("serves the Doqs documentation inside the site shell", async ({ page }) => {
  const errors = collectAngularErrors(page);

  await page.goto("/docs/getting-started");

  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(page.getByRole("heading", { level: 1, name: "Getting started" })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Strata home" })).toHaveAttribute("href", "/");

  await page.getByRole("link", { name: "Compatibility" }).first().click();
  await expect(page).toHaveURL(/\/docs\/compatibility$/);
  await expect(page.getByRole("heading", { level: 1, name: "Compatibility" })).toBeVisible();

  await page.getByRole("link", { name: "Why Strata" }).first().click();
  await expect(page).toHaveURL(/\/#why$/);
  await expect(page.locator("#why")).toBeVisible();

  expect(errors).toEqual([]);
});

test("reaches the documentation from the landing page in the same tab", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");

  await page.getByRole("link", { name: "Read the docs" }).first().click();

  await expect(page).toHaveURL(/\/docs\/getting-started$/);
});

test("answers an unknown page with a real 404", async ({ page }) => {
  const response = await page.goto("/no-such-page");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
});

test("the navigation marks where the reader is", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  const current = nav.locator("[aria-current]");

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(current).toHaveCount(0);

  for (const [id, label] of [
    ["server-components", "Server Components"],
    ["why", "Why Strata"],
    ["controllers", "Controllers"],
    ["architecture", "Architecture"],
    ["start", "Quick start"],
  ]) {
    await page.locator(`#${id}`).evaluate((section) => section.scrollIntoView());
    await expect(current).toHaveText(label);
  }

  // A part of a section with no link of its own still belongs to that section.
  await page.locator("#server-components-code").evaluate((section) => section.scrollIntoView());
  await expect(current).toHaveText("Server Components");

  await page.goto("/docs/getting-started");
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
  await expect(current).toHaveText("Docs");

  await page.getByRole("link", { name: "Compatibility" }).first().click();
  await expect(page).toHaveURL(/\/docs\/compatibility$/);
  await expect(current).toHaveText("Docs");
});
