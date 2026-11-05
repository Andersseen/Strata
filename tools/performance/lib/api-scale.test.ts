import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  BODY_LIMIT_BYTES,
  SCALE_MARKERS,
  SCALE_RESOURCES,
  burstPlan,
  burstProblems,
  burstRound,
  cleanupProblems,
  keepAliveAfterOversized,
  parseControllerCount,
  peakRssKiB,
  runBurst,
} from "./api-scale.ts";
import type { BurstOutcome } from "./api-scale.ts";

describe("controller scaling profile", () => {
  it("accepts only the listed controller counts", () => {
    expect(parseControllerCount(undefined)).toBe(1);
    expect(parseControllerCount("")).toBe(1);
    expect(parseControllerCount("8")).toBe(8);
    expect(() => parseControllerCount("4")).toThrow(/one of 1, 8/);
  });

  it("builds a deterministic round: every resource read, one of each failure kind, 12 ledgers", () => {
    const round = burstRound(0);

    expect(round).toHaveLength(15);
    expect(round.filter((r) => r.ledger)).toHaveLength(12);
    expect(
      new Set(round.filter((r) => r.kind === "read").map((r) => r.path.split("/")[3])),
    ).toEqual(new Set(SCALE_RESOURCES));
    expect(round.find((r) => r.kind === "oversized")!.body!.length).toBeGreaterThan(
      BODY_LIMIT_BYTES,
    );
    expect(round.find((r) => r.kind === "denied")).toMatchObject({
      method: "DELETE",
      ledger: false,
    });
    expect(burstPlan(3)).toHaveLength(45);
    expect(burstRound(1).find((r) => r.kind === "create")!.path).not.toBe(
      burstRound(0).find((r) => r.kind === "create")!.path,
    );
  });
});

describe("burst answers", () => {
  const read = burstRound(0)[0]!;
  const failure = burstRound(0).find((r) => r.kind === "failure")!;
  const answer = (over: Partial<BurstOutcome>): BurstOutcome => ({
    request: read,
    status: 200,
    body: '{"id":"42","resource":"r1"}',
    contentType: "application/json",
    ms: 1,
    ...over,
  });

  it("accepts exactly the expected answer", () => {
    expect(burstProblems(answer({}))).toEqual([]);
    expect(
      burstProblems(
        answer({ request: failure, status: 500, body: "<html>", contentType: "text/html" }),
      ),
    ).toEqual([]);
  });

  it("rejects a wrong status, a leaked failure, a wrong type and a foreign body", () => {
    expect(burstProblems(answer({ status: 400 }))).toEqual([
      expect.stringMatching(/400, expected 200/),
    ]);
    expect(
      burstProblems(answer({ request: failure, status: 500, body: SCALE_MARKERS.privateFailure })),
    ).toEqual([expect.stringMatching(/private failure text/)]);
    expect(burstProblems(answer({ contentType: "text/html" }))).toEqual([
      expect.stringMatching(/content-type/),
    ]);
    expect(burstProblems(answer({ body: '{"id":"7"}' }))).toEqual([
      expect.stringMatching(/unexpected body/),
    ]);
  });

  it("accounts for every ledger the plan opens", () => {
    const plan = burstPlan(2);
    const before = { opened: 10, closed: 10, open: 0 };

    expect(cleanupProblems(before, { opened: 34, closed: 34, open: 0 }, plan)).toEqual([]);
    expect(cleanupProblems(before, { opened: 34, closed: 33, open: 1 }, plan)).toEqual([
      "23 ledgers released of 24 opened",
      "1 ledgers still open after the burst",
    ]);
    expect(cleanupProblems(before, { opened: 30, closed: 30, open: 0 }, plan)).toEqual([
      "20 ledgers opened, expected 24",
    ]);
  });
});

describe("peak resident memory", () => {
  it("reads the kernel high-water mark and refuses to invent one", () => {
    expect(peakRssKiB(1, () => "Name:\tnode\nVmHWM:\t  123456 kB\nVmRSS:\t 100 kB\n")).toBe(123456);
    expect(
      peakRssKiB(1, () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("against a local server", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const listen = async (server: Server): Promise<string> => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  };

  it("keeps a connection usable after a 413 that drains the body", async () => {
    const base = await listen(
      createServer((request, response) => {
        if (request.method === "POST") {
          request.resume();
          request.on("end", () => {
            response.writeHead(413, { "content-type": "application/json" }).end("{}");
          });

          return;
        }
        response.writeHead(200).end("ok");
      }),
    );

    expect(await keepAliveAfterOversized(base, "/api/scale/r1", "/api/products/42")).toEqual({
      first: 413,
      second: 200,
      reused: true,
    });
  });

  it("runs the plan once, never retries, and reports wrong answers and cleanup", async () => {
    let opened = 0;
    const base = await listen(
      createServer((request, response) => {
        const json = (status: number, body: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };

        request.resume();
        request.on("end", () => {
          const url = request.url ?? "";

          if (url === "/api/scale/stats") return json(200, { opened, closed: opened, open: 0 });
          if (url.endsWith("/fail")) return json(500, { error: "internal" });
          if (request.method === "DELETE") return json(403, { error: "forbidden" });
          if (url.startsWith("/api/scale/") && request.method === "GET") {
            opened++;

            return json(200, { id: "42" });
          }

          return json(200, { id: "42" }); // every POST answers 200: wrong on purpose
        });
      }),
    );
    const result = await runBurst(base, burstRound(0), 4, { healthy: () => Promise.resolve(true) });

    expect(result.requests).toBe(15);
    expect(result.invalid).toBe(3); // create (201), invalid (400) and oversized (413) all got 200
    expect(result.cleanupProblems).toEqual(["8 ledgers opened, expected 12"]);
    expect(result.healthyAfter).toBe(true);
  });
});
