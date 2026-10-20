import { describe, expect, it } from "vitest";

import { jsonResponse, noContent } from "./responses.js";

describe("HTTP response helpers", () => {
  it("serializes JSON once and preserves caller headers and status", async () => {
    let serializations = 0;
    const value = {
      toJSON() {
        serializations += 1;
        return { ok: true };
      },
    };
    const response = jsonResponse(value, {
      status: 201,
      headers: [
        ["cache-control", "private, max-age=30"],
        ["x-contract", "preserved"],
      ],
    });

    expect(serializations).toBe(1);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
    expect(response.headers.get("x-contract")).toBe("preserved");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("preserves explicit JSON content type and multiple Set-Cookie values", () => {
    const headers = new Headers();
    headers.set("content-type", "application/vnd.example+json");
    headers.append("set-cookie", "one=1; Path=/; HttpOnly");
    headers.append("set-cookie", "two=2; Path=/; Secure");

    const response = jsonResponse({ ok: true }, { headers });

    expect(response.headers.get("content-type")).toBe("application/vnd.example+json");
    expect(response.headers.getSetCookie()).toEqual([
      "one=1; Path=/; HttpOnly",
      "two=2; Path=/; Secure",
    ]);
  });

  it("returns a bodyless 204 without adding a content type", async () => {
    const response = noContent({ headers: { "x-result": "deleted" } });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("x-result")).toBe("deleted");
    expect(await response.text()).toBe("");
  });

  it("rejects invalid statuses and unrepresentable JSON bodies", () => {
    expect(() => jsonResponse({}, { status: 99 })).toThrow(RangeError);
    expect(() => jsonResponse({}, { status: 600 })).toThrow(RangeError);
    expect(() => jsonResponse({}, { status: 204 })).toThrow(TypeError);
    expect(() => jsonResponse(undefined)).toThrow(TypeError);
    expect(() => jsonResponse(1n)).toThrow(TypeError);
  });
});
