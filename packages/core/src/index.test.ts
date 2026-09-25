import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { Controller, Get, getControllerDefinition, STRATA_VERSION } from "./index.js";

describe("@strata-sc/core", () => {
  it("exposes the current package version", () => {
    // Changesets bumps package.json; this keeps the exported constant in step with it.
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(STRATA_VERSION).toBe(packageJson.version);
  });

  it("exposes Controller, Get, and getControllerDefinition from the public barrel", () => {
    @Controller("/users")
    class UsersController {
      @Get()
      findAll() {}
    }

    expect(getControllerDefinition(UsersController)?.path).toBe("/users");
  });
});
