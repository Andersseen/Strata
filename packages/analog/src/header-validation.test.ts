import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Controller, Get } from "@strata-sc/core";
import { createApp, createRouter, toWebHandler } from "h3";
import * as v from "valibot";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { RegisterControllersOptions } from "./register-controllers.js";

import type {
  StrataAnalogRequest,
  StrataAnalogRequestObservation,
  StrataAnalogHeaders,
} from "./index.js";
import { registerControllers } from "./index.js";

const AUTH = "Bearer HEADER_AUTH_CANARY";
const COOKIE = "session=HEADER_COOKIE_CANARY";
const ISSUE = "HEADER_ISSUE_CANARY";
const VALUE = "HEADER_VALUE_CANARY";

function harness(
  controllers: Parameters<typeof registerControllers>[1],
  options: RegisterControllersOptions = {},
) {
  const app = createApp();
  const router = createRouter({ preemptive: true });
  app.use(router.handler);
  const observations: StrataAnalogRequestObservation[] = [];
  registerControllers(router, controllers, {
    ...options,
    onRequestSettled: (observation) => observations.push(observation),
  });
  const handle = toWebHandler(app);
  return {
    observations,
    request: (path: string, headers: ConstructorParameters<typeof Headers>[0] = {}) =>
      handle(new Request(`http://localhost${path}`, { headers })),
  };
}

const handwritten = {
  "~standard": {
    version: 1,
    vendor: "handwritten",
    validate: (value: unknown) => {
      const record = value as Record<string, string>;
      return typeof record["x-id"] === "string"
        ? { value: { id: record["x-id"] } }
        : { issues: [{ message: ISSUE }] };
    },
    types: { input: undefined, output: { id: "" } },
  },
} satisfies StandardSchemaV1<unknown, { id: string }>;

const schema = z.object({
  "x-request-id": z.string().min(1).max(128),
  "x-client-version": z.string().min(1),
  "x-optional": z.string().optional(),
});

@Controller("/h")
class HeadersController {
  @Get("/zod")
  async zod(request: StrataAnalogRequest) {
    const meta = await request.validateHeaders(schema);
    expectTypeOf(meta).toEqualTypeOf<{
      "x-request-id": string;
      "x-client-version": string;
      "x-optional"?: string | undefined;
    }>();
    return meta;
  }
  @Get("/transform")
  async transform(request: StrataAnalogRequest) {
    return request.validateHeaders(
      z.object({ "x-count": z.string().transform((value) => Number(value)) }),
    );
  }
  @Get("/async")
  async asynchronous(request: StrataAnalogRequest) {
    return request.validateHeaders(
      z.object({
        "x-id": z.string().refine(async (value) => {
          await Promise.resolve();
          return value === "ok";
        }),
      }),
    );
  }
  @Get("/valibot")
  valibot(request: StrataAnalogRequest) {
    return request.validateHeaders(v.object({ "x-id": v.pipe(v.string(), v.minLength(1)) }));
  }
  @Get("/handwritten")
  async hand(request: StrataAnalogRequest) {
    const out = await request.validateHeaders(handwritten);
    expectTypeOf(out).toEqualTypeOf<{ id: string }>();
    return out;
  }
  @Get("/raw")
  async raw(request: StrataAnalogRequest) {
    return request.validateHeaders(z.record(z.string(), z.string()));
  }
  @Get("/untouched")
  plain(request: StrataAnalogRequest) {
    return { id: request.headers.get("x-id") };
  }
  @Get("/secret")
  async secret(request: StrataAnalogRequest) {
    return request.validateHeaders(
      z.object({ authorization: z.string().refine(() => false, ISSUE) }),
    );
  }
  @Get("/slow/:ms")
  async slow(request: StrataAnalogRequest) {
    const out = await request.validateHeaders(z.object({ "x-id": z.string() }));
    await new Promise((resolve) => setTimeout(resolve, Number(request.params["ms"])));
    return {
      ...out,
      again: (await request.validateHeaders(z.object({ "x-id": z.string() })))["x-id"],
    };
  }
}

const base = { "x-request-id": "r1", "x-client-version": "1.2" };

describe("validateHeaders", () => {
  const h = harness([HeadersController]);

  it("validates mixed-case, optional, unknown and empty-ish headers", async () => {
    const ok = await h.request("/h/zod", {
      "X-Request-ID": "abc",
      "X-CLIENT-Version": "1.2",
      host: "ignored",
      "user-agent": "x",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ "x-request-id": "abc", "x-client-version": "1.2" });
    const optional = await h.request("/h/zod", { ...base, "x-optional": "" });
    expect(await optional.json()).toMatchObject({ "x-optional": "" });
  });

  it("rejects missing, empty and over-long required headers safely", async () => {
    for (const headers of [
      {},
      { "x-client-version": "1" },
      { ...base, "x-request-id": "" },
      { ...base, "x-request-id": "x".repeat(129) },
    ]) {
      const response = await h.request("/h/zod", headers);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe('{"error":"invalid_request","source":"headers"}');
    }
  });

  it("preserves commas, colons and unicode values without splitting or coercing", async () => {
    const response = await h.request("/h/raw", {
      "x-list": "a, b,c",
      "x-time": "12:30:45",
      "x-uni": "café",
      "x-num": "007",
    });
    const body = (await response.json()) as Record<string, string>;
    expect(body["x-list"]).toBe("a, b,c");
    expect(body["x-time"]).toBe("12:30:45");
    expect(body["x-uni"]).toBe("café");
    expect(body["x-num"]).toBe("007");
  });

  it("receives repeated fields exactly as the native Headers API combines them", async () => {
    const headers = new Headers();
    headers.append("x-dup", "one");
    headers.append("X-Dup", "two");
    const native = headers.get("x-dup");
    const response = await h.request("/h/raw", headers);
    expect(((await response.json()) as Record<string, string>)["x-dup"]).toBe(native);
    expect(native).toBe("one, two");
  });

  it("applies transformations, async validators, Valibot and handwritten schemas", async () => {
    expect(await (await h.request("/h/transform", { "x-count": "42" })).json()).toEqual({
      "x-count": 42,
    });
    expect((await h.request("/h/async", { "x-id": "ok" })).status).toBe(200);
    const bad = await h.request("/h/async", { "x-id": "no" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_request", source: "headers" });
    expect(await (await h.request("/h/valibot", { "x-id": "a" })).json()).toEqual({ "x-id": "a" });
    expect((await h.request("/h/valibot")).status).toBe(400);
    expect(await (await h.request("/h/handwritten", { "x-id": "z" })).json()).toEqual({ id: "z" });
    expect((await h.request("/h/handwritten")).status).toBe(400);
  });

  it("leaves request.headers and unvalidated controllers unchanged", async () => {
    expect(await (await h.request("/h/untouched", { "X-Id": "keep" })).json()).toEqual({
      id: "keep",
    });
    expect(h.observations.at(-1)).toMatchObject({ outcome: "completed" });
  });

  it("never reflects header values, issue messages or credentials", async () => {
    const response = await h.request("/h/secret", {
      authorization: AUTH,
      cookie: COOKIE,
      "x-custom": VALUE,
    });
    const text = await response.text();
    expect(response.status).toBe(400);
    for (const canary of [AUTH, COOKIE, ISSUE, VALUE, "HEADER_"])
      expect(text).not.toContain(canary);
    expect(JSON.stringify(h.observations.at(-1))).not.toMatch(/HEADER_|Bearer|session=/);
    expect(h.observations.at(-1)).toMatchObject({ outcome: "input-rejected", status: 400 });
  });

  it("builds a null-prototype-safe, frozen own-property snapshot", async () => {
    let seen: StrataAnalogHeaders | undefined;
    @Controller("/snap")
    class Snap {
      @Get()
      async get(request: StrataAnalogRequest) {
        seen = await request.validateHeaders(z.record(z.string(), z.string()));
        const again = await request.validateHeaders({
          "~standard": {
            version: 1,
            vendor: "probe",
            validate: (value: unknown) => ({ value }),
          },
        });
        expect(Object.isFrozen(again)).toBe(true);
        expect(Object.getPrototypeOf(again)).toBe(Object.prototype);
        expect(Object.hasOwn(again as object, "x-id")).toBe(true);
        return { polluted: ({} as Record<string, unknown>)["x-id"] };
      }
    }
    const response = await harness([Snap]).request("/snap", { "x-id": "1", __proto__x: "1" });
    expect(await response.json()).toEqual({});
    expect(seen).toBeDefined();
    expect(Object.keys(seen ?? {}).sort()).toContain("x-id");
  });

  it("keeps overlapping requests isolated", async () => {
    const hh = harness([HeadersController]);
    const results = await Promise.all(
      Array.from({ length: 24 }, async (_, i) => {
        const response = await hh.request(`/h/slow/${String(30 - i)}`, {
          "x-id": `id-${String(i)}`,
        });
        return (await response.json()) as { "x-id": string; again: string };
      }),
    );
    results.forEach((result, i) => {
      expect(result).toEqual({ "x-id": `id-${String(i)}`, again: `id-${String(i)}` });
    });
  });
});

describe("validateHeaders — failures and lifecycle", () => {
  function failing(validate: () => unknown, extra: RegisterControllersOptions = {}) {
    @Controller("/f")
    class F {
      @Get()
      run(request: StrataAnalogRequest) {
        return request.validateHeaders({
          "~standard": { version: 1, vendor: "t", validate },
        } as never);
      }
    }
    return harness([F], extra);
  }

  it("treats malformed metadata and validator failures as application errors, not 400", async () => {
    @Controller("/m")
    class M {
      @Get("/meta")
      meta(request: StrataAnalogRequest) {
        return request.validateHeaders({ "~standard": { version: 2 } } as never);
      }
    }
    const meta = harness([M]);
    expect((await meta.request("/m/meta")).status).toBe(500);
    expect(meta.observations.at(-1)).toMatchObject({ outcome: "failed" });

    const cases: [string, () => unknown][] = [
      [
        "throws",
        () => {
          throw new Error(`private ${VALUE}`);
        },
      ],
      ["rejects", () => Promise.reject(new Error(`private ${VALUE}`))],
      ["malformed", () => "nope"],
    ];
    for (const [, validate] of cases) {
      const t = failing(validate);
      const response = await t.request("/f", { authorization: AUTH });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(VALUE);
      expect(t.observations.at(-1)).toMatchObject({ outcome: "failed" });
    }
  });

  it("cleans up after failed validation and lets cleanup failure win", async () => {
    let cleanups = 0;
    const ok = harness([HeadersController], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          cleanups += 1;
        });
        return new controller();
      },
    });
    expect((await ok.request("/h/zod")).status).toBe(400);
    expect(cleanups).toBe(1);
    expect(ok.observations.at(-1)).toMatchObject({
      outcome: "input-rejected",
      cleanup: "completed",
    });

    const bad = harness([HeadersController], {
      controllerFactory(controller, { onCleanup }) {
        onCleanup(() => {
          throw new Error(`cleanup ${VALUE}`);
        });
        return new controller();
      },
    });
    const response = await bad.request("/h/zod");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).not.toBe("no-store");
    expect(await response.text()).not.toContain('"source":"headers"');
    expect(bad.observations.at(-1)).toMatchObject({ outcome: "cleanup-failed", cleanup: "failed" });
  });

  it("lets an interceptor observe the validation failure", async () => {
    const seen: unknown[] = [];
    const t = harness([HeadersController], {
      interceptors: [
        async (_context, next) => {
          try {
            return await next();
          } catch (error) {
            seen.push(error);
            throw error;
          }
        },
      ],
    });
    expect((await t.request("/h/zod")).status).toBe(400);
    expect(seen).toHaveLength(1);
    expect(t.observations.at(-1)).toMatchObject({ outcome: "input-rejected", phase: "execution" });
  });
});
