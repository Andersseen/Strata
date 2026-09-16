import { describe, expect, it } from "vitest";

import { Controller, Get, getControllerDefinition, STRATA_VERSION } from "./index.js";

describe("@strata/core", () => {
  it("exposes the current package version", () => {
    expect(STRATA_VERSION).toBe("0.0.0");
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
