import { describe, expect, it } from "vitest";

import { normalizePath } from "./normalize-path.js";

describe("normalizePath", () => {
  it("defaults missing input to the root path", () => {
    expect(normalizePath(undefined)).toBe("/");
  });

  it("defaults an empty string to the root path", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("keeps the root path as-is", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("adds a missing leading slash", () => {
    expect(normalizePath("users")).toBe("/users");
  });

  it("keeps an existing leading slash", () => {
    expect(normalizePath("/users")).toBe("/users");
  });

  it("strips a trailing slash", () => {
    expect(normalizePath("/users/")).toBe("/users");
  });

  it("collapses repeated slashes", () => {
    expect(normalizePath("//users///profile//")).toBe("/users/profile");
  });

  it("normalizes a bare path param", () => {
    expect(normalizePath(":id")).toBe("/:id");
  });

  it("normalizes a leading-slash path param", () => {
    expect(normalizePath("/:id")).toBe("/:id");
  });
});
