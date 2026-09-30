import type { Page } from "@playwright/test";

// Angular's own runtime errors (hydration mismatches, NG0xxx codes, duplicate
// component or selector collisions) and uncaught page errors.
const ANGULAR_ERROR = /hydrat|NG0\d{3}|duplicate|selector|multiple components match/i;

export function collectAngularErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      (message.type() === "warning" && ANGULAR_ERROR.test(message.text()))
    ) {
      errors.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  return errors;
}
