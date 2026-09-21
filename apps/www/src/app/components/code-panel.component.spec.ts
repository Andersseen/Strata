import { fireEvent, render, screen } from "@testing-library/angular";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodePanelComponent } from "./code-panel.component";

describe("CodePanelComponent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders a named example and copies its exact source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await render(CodePanelComponent, {
      componentInputs: { filename: "users.controller.ts", code: "export class UsersController {}" },
    });

    expect(screen.getByText("users.controller.ts")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("export class UsersController {}");
    expect(await screen.findByRole("button", { name: "Copied" })).not.toBeNull();
  });
});
