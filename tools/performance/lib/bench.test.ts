import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  concurrent,
  isPortCollision,
  measureTarget,
  sequential,
  startWithPortRetry,
  timedGet,
  warmUp,
} from "./bench.ts";
import type { Target } from "./bench.ts";

let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    hits++;
    if (request.url === "/ok") {
      response.end("fine");
    } else if (request.url === "/flaky") {
      // Every fourth response is a 500 with a body that would be a very fast "success".
      response.statusCode = hits % 4 === 0 ? 500 : 200;
      response.end(response.statusCode === 200 ? "fine" : "boom");
    } else {
      response.statusCode = 404;
      response.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

const target = (path: string): Target => ({
  name: "api",
  path,
  validate: ({ status, body }) => (status === 200 && body === "fine" ? [] : [`status ${status}`]),
});

describe("timedGet", () => {
  it("times a response whose body is fully read", async () => {
    const timed = await timedGet(`${base}/ok`);

    expect(timed.status).toBe(200);
    expect(timed.body).toBe("fine");
    expect(timed.ms).toBeGreaterThan(0);
  });

  it("reports a refused connection as status 0, never as a fast success", async () => {
    const timed = await timedGet("http://127.0.0.1:1/never", 2_000);

    expect(timed.status).toBe(0);
  });
});

describe("sampling", () => {
  it("marks failing responses invalid and excludes them from the percentiles", async () => {
    const samples = await sequential(base, target("/flaky"), 20);

    expect(samples).toHaveLength(20);
    expect(samples.filter((s) => !s.valid).length).toBeGreaterThan(0);
    expect(samples.filter((s) => !s.valid).every((s) => s.status === 500)).toBe(true);
  });

  it("runs the requested number of requests under bounded concurrency", async () => {
    const run = await concurrent(base, target("/ok"), 30, 5);

    expect(run.samples).toHaveLength(30);
    expect(run.samples.every((s) => s.valid)).toBe(true);
    expect(run.wallMs).toBeGreaterThan(0);
  });

  it("reports warm-up problems without sampling them", async () => {
    expect(await warmUp(base, target("/missing"), 3)).toEqual(["status 404"]);
    expect(await warmUp(base, target("/ok"), 3)).toEqual([]);
  });

  it("measures a target and keeps invalid responses out of every statistic", async () => {
    const good = await measureTarget(base, target("/ok"), {
      warmup: 2,
      requests: 10,
      concurrency: 2,
    });
    const bad = await measureTarget(base, target("/missing"), {
      warmup: 2,
      requests: 10,
      concurrency: 2,
    });

    expect(good.sequential.invalid).toBe(0);
    expect(good.sequential.p95).not.toBeNull();
    expect(bad.sequential.valid).toBe(0);
    expect(bad.sequential.p50).toBeNull();
    expect(bad.sequential.statuses).toEqual({ "404": 10 });
    expect(bad.warmup.problems).toEqual(["status 404"]);
  });
});

describe("startWithPortRetry", () => {
  const collision = new Error(
    "*** Fatal uncaught kj::Exception: bind(): Address already in use (os error 98)",
  );

  it("recognizes only port collisions", () => {
    expect(isPortCollision(collision)).toBe(true);
    expect(isPortCollision(new Error("listen EADDRINUSE: address already in use"))).toBe(true);
    expect(isPortCollision(new Error("Server exited before answering"))).toBe(false);
    expect(isPortCollision("boom")).toBe(false);
  });

  it("starts again after a collision and returns the successful start", async () => {
    let calls = 0;
    const seen: number[] = [];
    const result = await startWithPortRetry(
      async () => {
        if (++calls < 3) throw collision;

        return "up";
      },
      3,
      (attempt) => seen.push(attempt),
    );

    expect(result).toBe("up");
    expect(calls).toBe(3);
    expect(seen).toEqual([1, 2]);
  });

  it("gives up after the allowed attempts and surfaces the collision", async () => {
    let calls = 0;

    await expect(
      startWithPortRetry(async () => {
        calls++;
        throw collision;
      }, 3),
    ).rejects.toBe(collision);
    expect(calls).toBe(3);
  });

  it("never retries a different failure", async () => {
    let calls = 0;

    await expect(
      startWithPortRetry(async () => {
        calls++;
        throw new Error("the worker threw while rendering");
      }),
    ).rejects.toThrow("the worker threw");
    expect(calls).toBe(1);
  });
});
