import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { concurrent, measureTarget, sequential, timedGet, warmUp } from "./bench.ts";
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
