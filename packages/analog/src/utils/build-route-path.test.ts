import { describe, expect, it } from "vitest";

import { buildRoutePath } from "./build-route-path.js";

describe("buildRoutePath", () => {
  it("uses only the controller path when the route path is root", () => {
    expect(buildRoutePath("/users", "/")).toBe("/users");
  });

  it("appends a non-root route path to the controller path", () => {
    expect(buildRoutePath("/users", "/:id")).toBe("/users/:id");
  });

  it("uses only the route path when the controller path is root", () => {
    expect(buildRoutePath("/", "/health")).toBe("/health");
  });

  it("resolves to root when both paths are root", () => {
    expect(buildRoutePath("/", "/")).toBe("/");
  });
});
