import { render, screen } from "@testing-library/angular";
import { describe, expect, it } from "vitest";

import { App } from "./app";

describe("App", () => {
  it("composes the public landing page from its section components", async () => {
    await render(App);

    expect(screen.getByRole("heading", { name: /give your server structure/i })).not.toBeNull();
    expect(screen.getByRole("heading", { name: /native to the nitro seam/i })).not.toBeNull();
    expect(screen.getByRole("link", { name: /view on github/i }).getAttribute("href")).toBe(
      "https://github.com/Andersseen/Strata",
    );
  });
});
