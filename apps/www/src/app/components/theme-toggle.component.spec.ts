import { fireEvent, render, screen } from "@testing-library/angular";
import { afterEach, describe, expect, it } from "vitest";

import { ThemeToggleComponent } from "./theme-toggle.component";

describe("ThemeToggleComponent", () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
  });

  it("switches the document theme and persists the user's choice", async () => {
    await render(ThemeToggleComponent);

    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("strata-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).not.toBeNull();
  });
});
