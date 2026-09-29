import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  Controller,
  Delete,
  Get,
  getControllerDefinition,
  Patch,
  Post,
  Put,
  STRATA_VERSION,
} from "./index.js";

describe("@strata-sc/core", () => {
  it("exposes the current package version", () => {
    // Changesets bumps package.json; this keeps the exported constant in step with it.
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(STRATA_VERSION).toBe(packageJson.version);
  });

  it("exposes Controller, every HTTP method decorator and getControllerDefinition from the public barrel", () => {
    @Controller("/api/items")
    class ItemsController {
      @Get()
      list() {}

      @Post()
      create() {}

      @Put("/:id")
      replace() {}

      @Patch("/:id")
      update() {}

      @Delete("/:id")
      remove() {}
    }

    expect(getControllerDefinition(ItemsController)).toEqual({
      path: "/api/items",
      routes: [
        { method: "GET", path: "/", handler: "list" },
        { method: "POST", path: "/", handler: "create" },
        { method: "PUT", path: "/:id", handler: "replace" },
        { method: "PATCH", path: "/:id", handler: "update" },
        { method: "DELETE", path: "/:id", handler: "remove" },
      ],
    });
  });
});
