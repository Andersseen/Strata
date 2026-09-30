import { render, screen } from "@testing-library/angular";
import { describe, expect, it } from "vitest";

import { App } from "./app";

describe("App", () => {
  it("composes the public landing page from its section components", async () => {
    await render(App);

    expect(
      screen.getByRole("heading", { name: /the server layer angular was missing/i }),
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: /angular components that stay on the server/i }),
    ).not.toBeNull();
    expect(screen.getByRole("heading", { name: /controllers for the http side/i })).not.toBeNull();
    expect(screen.getByRole("heading", { name: /native to the nitro seam/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /view on github/i })).not.toBeNull();
  });
});
